import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { Pool } from 'pg'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt' //manages salt automatically
import multer from 'multer' //upload files
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto' //generate unique file names
import rateLimit from 'express-rate-limit'
import cookieParser from 'cookie-parser' //HTTP only cookies
import cors from 'cors'
import sharp from 'sharp' //image thumbnails
import cron from 'node-cron'


//================= TYPES ===========================================================================================================
//extends Express's Request type to include your custom `user` property
//By default Request has no `user` field
//so req.user = result.rows[0] would throw an error
//This declaration merges `user` into Express's existing namespace
declare global {
  namespace Express {
    interface Request {
      user: {
        id: number
        username: string
      }
    }
  }
}

//users table -> user row
interface DbUser {
  id: number
  username: string
  password_hash: string
  created_at: Date
}

//files table -> file row
interface DbFile {
  id: number
  user_id: number
  filename: string
  original_filename: string
  file_path: string
  file_size: number
  folder_id: number | null
  mime_type: string
  created_at: Date
  updated_at: Date
  thumbnail_path: string | null
  demo_file: boolean
}

//folders table -> folder row
interface DbFolder {
  id: number
  user_id: number
  name: string
  parent_folder_id: number | null
  path: string
  created_at: Date
}

//the object passed into processFolderRecursive
//PoolClient is pg's type for a checked-out DB connection
import type { PoolClient } from 'pg'

interface RecursiveDeleteContext {
  client: PoolClient
  userId: number
  trashPath: string
  movedFiles: Array<{ id: number; name: string }>
  deletedFolders: number[]
}



//===============================================================================================================================================

const app = express()
app.set('trust proxy', 1)

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : []

app.use(cors({
  origin: (origin, callback) => {
    //allow requests with no origin (curl, mobile apps, server-to-server)
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error(`CORS blocked: ${origin}`))
  },
  credentials: true, //allow cookies (refresh token)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type']
}))

//no page indexing server-level
app.use((req: Request, res: Response, next: NextFunction) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(express.json())  //parse JSON request bodies -> reads request, parses JSON and turns is into a js object attaching it to req.body
app.use(cookieParser()) //HTTP only cookies - against XSS(Cross-site scripting)

//global rate limiter: max 5000 requests per IP every 15mins on all routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: { error: 'Too many requests, please try again later' }
})
app.use(globalLimiter)

const port: number = process.env.PORT ? parseInt(process.env.PORT) : 3000 //in docker-compose.yml

const db = new Pool({
  connectionString: process.env.DATABASE_URL,//in docker-compose.yml
})


if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not set')
}
const JWT_SECRET: string = process.env.JWT_SECRET 



// ============= MIDDLEWARE: Authentication ===================================================================================================
//does the user have valid token?
async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1] //expected format: "Bearer TOKEN"

  if (!token) {
    res.status(403).json({ error: 'Access token required' })
    return
  }

  try {
    //verify the token and extract user info
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload
    const result = await db.query(
      'SELECT id, username FROM users WHERE id = $1',
      [decoded.sub]
    )

    if (result.rows.length === 0) {
      res.status(403).json({ error: 'User not found'})
      return
    }
    req.user = result.rows[0] as {id: number; username: string} //now I can access req.user.id and req.user.username in routes
    next()
  } catch (err) {
    console.error('authenticateToken error: ', err)
    res.status(403).json({ error: 'Invalid or expired token' })
    return
  }
}



// ============= MIDDLEWARE: folder name validation =======
const validateFolderName = (name: unknown): boolean => {
  if (!name || typeof name !== 'string') return false 
  if (name.length > 255) return false 
  if (!/^[a-zA-Z0-9_\- ]+$/.test(name)) return false 
  if (name.includes('..')) return false  //prevent path traversal
  return true 
} 


// ============= REGISTRATION ==================================================================================================================
//requires admin secret —> not a public endpoint, no rate limit needed
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const adminSecret = req.headers['x-admin-secret']
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Registration is not open' })
  }
  try {
    const { username, password } = req.body as {username: string; password: string} 

    //basic validation
    if (!username || !password) {
      return res.status(400).json({ error: 'All fields required' }) 
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' }) 
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores and dashes' }) 
    }

    //hash the password (10 salt rounds is standard)
    const passwordHash = await bcrypt.hash(password, 10) 

    //add user to db
    const result = await db.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username, passwordHash]
    ) 

    const user = result.rows[0] 

    //make user folder on db
    await db.query(
      'INSERT INTO folders (user_id, name, parent_folder_id, path) VALUES ($1, $2, NULL, $3)',
      [user.id, username, `/${username}`]
    ) 

    //make actual folder on the SSD
    const userDir = path.join('/app/storage', username) 
    if (!userDir.startsWith('/app/storage/')) {
      return res.status(400).json({ error: 'Registration error: Invalid user folder path' }) 
    }
    await fs.mkdir(userDir, { recursive: true }) 

    res.status(201).json({
      message: 'User registered successfully',
      user: user
    }) 


  } catch (err) {
    console.error('Registration error:', err) 
    const pgErr = err as { code?: string }
    
    //handle duplicate username
    if (pgErr.code === '23505') { //postgres unique violation code
      return res.status(409).json({ error: 'Registration error: Username already exists' }) 
    }
    
    res.status(500).json({ error: 'Registration failed' }) 
  }
}) 



// ============= LOGIN ========================================================================================================================
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 })
app.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as {username: string; password: string}

    if (!username || !password) {
      return res.status(400).json({ error: 'Login error: Username and password required' }) 
    }

    //find user in database
    const result = await db.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    ) 

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Login error: Invalid credentials' }) 
    }

    const user = result.rows[0] 

    //compare password with hash
    const validPassword = await bcrypt.compare(password, user.password_hash) 

    if (!validPassword) {
      return res.status(401).json({ error: 'Login error: Invalid credentials' }) 
    }

    //assign access token -> short-lived JWT
    const accessToken = jwt.sign(
      { sub: user.id }, //payload = data I want int the token
      JWT_SECRET,
      { expiresIn: '5m', algorithm: 'HS256' }
    )

    //create refresh token -> random bytes, not a JWT, hashed
    const refreshToken = crypto.randomBytes(64).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, tokenHash]
    )

    //path scopes the cookie to only be sent to auth endpoints
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.SECURE_COOKIES === 'true', //false in dev or local networks, only sent via HTTPS, prevents Man-in-the-Middle
      sameSite: 'lax', //protects aginst Cross-Site Request Forgery
      maxAge: 30 * 24 * 60 * 60 * 1000, //30 days in ms
      path: '/api/auth' //cookie only sent to /api/auth*
    })

    //cleanup expired refresh tokens from db if any
    await db.query(
      `DELETE FROM refresh_tokens
      WHERE expires_at < NOW() AND user_id = $1`,
      [user.id]
    )

    res.json({
      message: 'Login successful',
      accessToken,
      user: { id: user.id, username: user.username }
    })

  } catch (err) {
    console.error('Login error:', err) 
    res.status(500).json({ error: 'Login failed' }) 
  }
}) 



//============= REFRESH TOKEN ==================================================================================================================================
app.post('/api/auth/refresh', async (req: Request, res: Response) => {
  const refreshToken = req.cookies.refreshToken

  if (!refreshToken) {
    return res.status(401).json({ error: 'No refresh token' })
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
    //createHash makes an object that can transform strings using the sha256 algorithm (hash instance)
    //update feeds refreshToken to the hash object
    //digest finalizes the process and picks the encoding (hex)

    //is this token still valid and not expired?
    //compare refresh_token ans users tables, give me the user that has the token I'm checking now
    const result = await db.query(
      `SELECT rt.user_id, u.username
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.expires_at > NOW()`,
      [tokenHash]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' })
    }

    const { user_id, username } = result.rows[0]

    const accessToken = jwt.sign(
      { sub: user_id },
      JWT_SECRET,
      { expiresIn: '5m', algorithm: 'HS256' }
    )

    res.json({ accessToken, user: { id: user_id, username } })
  } catch (err) {
    console.error('Refresh error:', err)
    res.status(500).json({ error: 'Failed to refresh token' })
  }
})



//================== LOGOUT ==================================================================================================================================
app.post('/api/auth/logout', async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies.refreshToken

    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
      //delete refresh token from DB
      await db.query(
        'DELETE FROM refresh_tokens WHERE token_hash = $1',
        [tokenHash]
      )
    }

    //delete cookie from browser
    res.clearCookie('refreshToken', { path: '/api/auth' })
    res.json({ message: 'Logged out' })
  } catch (err) {
    console.error('Logout error:', err)
    res.status(500).json({ error: 'Logout failed' })
  }
})



//======= MAKE NEW FOLDER ========================================================================================================================================
app.post('/api/folders', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name, parentFolderId } = req.body as {name: string; parentFolderId: number}

    if (!validateFolderName(name)) {
      return res.status(400).json({ 
        error: 'Error making a new folder: Invalid folder name. Use only letters, numbers, spaces, dashes, and underscores.' 
      }) 
    }
    
    let parentPath = '' 
    
    if (parentFolderId) {
      //get parent folder
      const parent = await db.query(
        'SELECT path FROM folders WHERE id = $1 AND user_id = $2',
        [parentFolderId, req.user.id]
      ) 
      
      if (parent.rows.length === 0) {
        return res.status(404).json({ error: 'Error making a new folder: Parent folder not found' }) 
      }
      
      parentPath = parent.rows[0].path 
    } else {
      //root level
      const root = await db.query(
        'SELECT path FROM folders WHERE user_id = $1 AND parent_folder_id IS NULL',
        [req.user.id]
      )
      parentPath = root.rows[0].path
    }
    const fullPath = `${parentPath}/${name}` 
    
    //insert into db
    const result = await db.query(
      'INSERT INTO folders (user_id, name, parent_folder_id, path) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, name, parentFolderId || null, fullPath]
    ) 
    
    //create physical folder
    const physicalPath = path.join('/app/storage', fullPath) 
    //make sure /app/storage wasn't somehow escaped
    if (!physicalPath.startsWith('/app/storage/')) {
      return res.status(400).json({ error: 'Error making a new folder: Invalid path' }) 
    }
    await fs.mkdir(physicalPath, { recursive: true }) 
    
    res.status(201).json({ folder: result.rows[0] }) 
  } catch (err) {
    console.error('Make a new folder error:', err) 
    res.status(500).json({ error: 'Error making a new folder: Failed to create folder' }) 
  }
}) 



// ======= GET FOLDERS FOR 'MOVE' PATH PICKER ===================================================================================================================
app.get('/api/folders/all', authenticateToken, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, name, path, parent_folder_id FROM folders
       WHERE user_id = $1 ORDER BY path`,
      [req.user.id]
    ) 
    res.json({ folders: result.rows }) 
  } catch (err) {
    console.error('Error fetching folders for "move" path picker:', err)
    res.status(500).json({ error: 'Failed to fetch folders' }) 
  }
}) 



//===== LIST FOLDER CONTENTS =====================================================================================================================================
app.get('/api/folders{/:folderId}', authenticateToken, async (req: Request, res: Response) => {
  try {
    let folderId = req.params.folderId
    
    //if no folder is provided get the user's root folder

    if (!folderId) {
      const rootFolder = await db.query(
        `SELECT id FROM folders
        WHERE user_id = $1 AND parent_folder_id IS NULL`,
        [req.user.id]
      )

      if (rootFolder.rows.length === 0) {
        return res.status(404).json({ error: 'Error listing folder contents: Root folder not found' }) 
      }

      folderId = rootFolder.rows[0].id 
    }

    //make sure folder belongs to user and get details
    const folderInfo = await db.query(
      `SELECT * FROM folders 
      WHERE id = $1 AND user_id = $2`,
      [folderId, req.user.id]
    ) 
    
    if (folderInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Error listing folder contents: Folder not found' }) 
    }

    //get contents
    const [folders, files] = await Promise.all([
      db.query(
        `SELECT * FROM folders 
        WHERE user_id = $1 AND parent_folder_id = $2
        ORDER BY name`,
        [req.user.id, folderId]
      ),
      db.query(
        `SELECT * FROM files 
        WHERE user_id = $1 AND folder_id = $2
        ORDER BY created_at DESC`,
        [req.user.id, folderId]
      )
    ]) 

    res.json({ 
      folders: folders.rows, 
      files: files.rows,
      currentFolder: folderInfo.rows[0],
    }) 
  } catch (err) {
    console.error('Error listing folder contents:', err) 
    res.status(500).json({ error: 'Error listing folder contents: Failed to list contents' }) 
  }
}) 



// ============ UPLOAD ==============================================================================================================================
//MULTER config for file uploads
const storage = multer.diskStorage({
  destination: async (req: Request, file: Express.Multer.File, cb: (error: Error | null, destination: string) => void ) => {
    try {
      const userId = req.user.id 
      const username = req.user.username 
      const folderId = req.query.folderId  //TODO: user picks which folder

      let folderPath 
      
      if (folderId) {
        //get path of destination folder from database
        const result = await db.query(
          'SELECT path FROM folders WHERE id = $1 AND user_id = $2',
          [folderId, userId]
        ) 
        
        if (result.rows.length === 0) {
          return cb(new Error('Folder not found or access denied'), '') 
        }
        
        folderPath = result.rows[0].path 
      } else {
        //if null -> root folder
        folderPath = `/${username}` 
      }
      
      //convert db path to physical path
      //db: /testuser/Documents/Work
      //backend: /app/storage/testuser/Documents/Work
      //physical: /app/storage mounted by docker
      const physicalPath = path.join('/app/storage', folderPath) 
      if (!physicalPath.startsWith('/app/storage/')) {
        return cb(new Error('Invalid path'), '') 
      }
      
      //make directory if it doesn't exist
      await fs.mkdir(physicalPath, { recursive: true }) 
      
      cb(null, physicalPath) 
    } catch (err) {
      console.error('Multer destination error:', err) 
      cb(err as Error, '') 
    }
  },
  filename: (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string )=> void ) => {
    //CRYPTO unique filename to avoid conflicts
    const uniqueName = `${crypto.randomUUID()}${path.extname(file.originalname)}` 
    cb(null, uniqueName) 
  }
}) 

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } //100MB limit
}) 

//rate limit: 15 uploads per IP per hour
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Upload limit reached, try again later' } //triggers a 429 when exceeded
})

//generate the thumbnails for images with sharp
async function generateThumbnail(filePath: string, mimeType: string, username: string): Promise<string | null> {
  if (!mimeType.startsWith('image/')) return null

  const thumbnailDir = `/app/storage/thumbnails/${username}`
  await fs.mkdir(thumbnailDir, { recursive: true })

  const thumbnailPath = path.join(thumbnailDir, `${crypto.randomUUID()}.webp`)

  await sharp(filePath)
    .resize(200, 200, { fit: 'cover', position: 'centre' })
    .webp({ quality: 70 })
    .toFile(thumbnailPath)

  return thumbnailPath
}

app.post('/api/files/upload', authenticateToken, uploadLimiter, upload.array('files', 15), async (req: Request, res: Response) => {
  const client = await db.connect() 
  try {
    const { folderId } = req.body as {folderId: number}
    const files = req.files as Express.Multer.File[] | undefined

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Upload: No files provided' }) 
    }

    await client.query('BEGIN')

    //save file to db
    const insertedFiles = [] 
    for (const file of files) {
      const thumbnailPath = await generateThumbnail(file.path, file.mimetype, req.user.username)

      const result = await client.query(
        `INSERT INTO files (user_id, filename, original_filename, file_path, file_size, folder_id, mime_type, thumbnail_path)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.user.id, file.filename, file.originalname, file.path, file.size, folderId || null, file.mimetype, thumbnailPath]
      ) 
      insertedFiles.push(result.rows[0]) 
    }

    await client.query('COMMIT')
    res.status(201).json({ message: 'Files uploaded', files: insertedFiles }) 
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Upload error:', err) 

    //clean up physical files if db fails
    if (req.files) {
      const files = req.files as Express.Multer.File[]
      for (const file of files) {
        await fs.unlink(file.path).catch(console.error) 
      }
    }
    res.status(500).json({ error: 'Upload failed' }) 
  } finally {
    client.release()
  }
}) 



//============= GET THUMBNAILS ===============================================================================================================================
app.get('/api/files/:id/thumbnail', authenticateToken, async (req: Request, res: Response) => {
  const result = await db.query(
    'SELECT thumbnail_path, mime_type FROM files WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  )

  if (!result.rows[0] || !result.rows[0].thumbnail_path) {
    return res.status(404).json({ error: 'No thumbnail available' })
  }

  res.set('Content-Type', 'image/jpeg')
  res.set('Cache-Control', 'max-age=31536000, immutable') //cache forever —> thumbnails don't change
  res.sendFile(path.resolve(result.rows[0].thumbnail_path))
})  



// ============ PREVIEW FILE ================================================================================================================================
app.get('/api/files/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!Number.isInteger(Number(req.params.id)))
      return res.status(400).json({error: 'Preview file error: The ID is not a valid integer'})
    const result = await db.query(
      'SELECT * FROM files WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    ) 

    if (!result.rows[0]) return res.status(404).json({ error: 'Preview file error: Not found' }) 

    const file = result.rows[0] 
    res.set('Content-Type', file.mime_type) 
    res.sendFile(path.resolve(file.file_path)) 
  } catch (err) {
    console.error('Preview file error:', err) 
    res.status(500).json({ error: 'Preview file error: Failed to fetch file' }) 
  }
}) 



// =========== DELETE (move to trash) =======================================================================================================================================
//remove records from db, keep files in trash folder

//make sure trash folder exists
const ensureTrashFolder = async (username: string) => {
  //keep trash outside user directories, in app/storage/trash/userId/
  //app/storage is mapped to the local folder or the disk that stores the actual data
  const trashPath = path.join('/app/storage', 'trash', username)
  try {
    await fs.mkdir(trashPath, { recursive: true })
  } catch (err) {
    console.error('EnsureTrashFoler error: Failed to create trash folder:', err)
    throw err
  }
  return trashPath
}

async function processFolderRecursive(folderId: number, context: RecursiveDeleteContext): Promise<void> {
  const {client, userId, trashPath, movedFiles, deletedFolders} = context

  //delete all files in this folder
  const filesResult = await client.query(
    `SELECT id, file_path, filename, thumbnail_path FROM files 
      WHERE user_id = $1 AND folder_id = $2 AND demo_file = FALSE`,
    [userId, folderId]
  )

  for (const file of filesResult.rows) {
    try {
      const timestamp = Date.now()
      const randomStr = Math.random().toString(36).substring(7)
      const fileExtension = path.extname(file.filename)
      const baseFileName = path.basename(file.filename, fileExtension)
      const trashFileName = `${baseFileName}_${timestamp}_${randomStr}${fileExtension}`
      const trashFilePath = path.join(trashPath, trashFileName)

      await fs.copyFile(file.file_path, trashFilePath)
      await fs.unlink(file.file_path)

      //delete the thumbnail if there is one
      if (file.thumbnail_path) {
        await fs.unlink(file.thumbnail_path).catch(err => 
          console.error(`Failed to delete thumbnail for file ${file.id}:`, err)
        )
      }

      await client.query(
        `DELETE FROM files WHERE id = $1 AND user_id = $2`,
        [file.id, userId]
      )
      
      movedFiles.push({ id: file.id, name: file.filename })
    } catch (err) {
      console.error(`CONSISTENCY WARNING: DB transaction will rollback but file may have been partially moved to trash. Manual cleanup may be needed. File path: ${file.file_path}, Trash path: ${trashPath}`, err)
      throw err
    }
  }

  //recurse into subfolders
  const subfoldersResult = await client.query(
    `SELECT id FROM folders 
      WHERE user_id = $1 AND parent_folder_id = $2`,
    [userId, folderId]
  )

  for (const subfolder of subfoldersResult.rows) {
    await processFolderRecursive(subfolder.id, { client, userId, trashPath, movedFiles, deletedFolders })
  }

  //fetch path BEFORE deleting the row
  const thisFolderResult = await client.query(
    `SELECT path FROM folders WHERE id = $1`,
    [folderId]
  )
  const thisFolderPath = thisFolderResult.rows[0].path

  //delete folder from DB
  const deleteResult = await client.query(
    `DELETE FROM folders 
      WHERE id = $1 AND user_id = $2
      RETURNING id`,
    [folderId, userId]
  )

  //delete physical directory
  if (deleteResult.rows.length > 0) {
    deletedFolders.push(folderId)
    const physicalFolderPath = path.join('/app/storage', thisFolderPath)
    if (!physicalFolderPath.startsWith('/app/storage/')) {
      throw new Error('Recursive folder processing error: Invalid path')
    }
    await fs.rm(physicalFolderPath, { recursive: false }).catch(err =>
      console.error(`processFolderRecursive error: Failed to remove directory ${physicalFolderPath}:`, err)
    )
  }
}

app.delete('/api/delete', authenticateToken, async (req: Request, res: Response) => {
  const client = await db.connect()
  
  try {
    const { fileIds = [], folderIds = [] } = req.body
    
    if (!Array.isArray(fileIds) || !Array.isArray(folderIds)) {
      return res.status(400).json({ error: 'Deletion error: fileIds and folderIds must be arrays' })
    }

    if (fileIds.length === 0 && folderIds.length === 0) {
      return res.status(400).json({ error: 'Deletion error: No items selected for deletion' })
    }

    await client.query('BEGIN')

    const userResult = await client.query(
      'SELECT username FROM users WHERE id = $1',
      [req.user.id]
    )
    const username = userResult.rows[0].username
    const trashPath = await ensureTrashFolder(username)

    let movedFiles: Array<{ id: number; name: string }> = []
    let deletedFolders: number[] = []

    //process individually selected files
    for (const fileId of fileIds) {
      const fileResult = await client.query(
        `SELECT id, file_path, filename, thumbnail_path FROM files 
         WHERE id = $1 AND user_id = $2 AND demo_file = FALSE`,
        [fileId, req.user.id]
      )

      if (fileResult.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(403).json({ 
          error: `Deletion error: File ${fileId} not found or access denied` 
        })
      }

      const file = fileResult.rows[0]

      const timestamp = Date.now()
      const randomStr = Math.random().toString(36).substring(7)
      const fileExtension = path.extname(file.filename)
      const baseFileName = path.basename(file.filename, fileExtension)
      const trashFileName = `${baseFileName}_${timestamp}_${randomStr}${fileExtension}`
      const trashFilePath = path.join(trashPath, trashFileName)

      try {
        await fs.copyFile(file.file_path, trashFilePath)
        await fs.unlink(file.file_path)

        //delete thumbnail if it exists
        if (file.thumbnail_path) {
          await fs.unlink(file.thumbnail_path).catch(err => 
            console.error(`Failed to delete thumbnail for file ${file.id}:`, err)
          )
        }

        await client.query(
          `DELETE FROM files WHERE id = $1 AND user_id = $2`,
          [fileId, req.user.id]
        )

        movedFiles.push({ id: fileId, name: file.filename })
      } catch (err) {
        console.error(`Delete error: Failed to move file to trash:`, err)
        await client.query('ROLLBACK')
        return res.status(500).json({ error: 'Deletion error: Failed to move file to trash' })
      }
    }

    //process selected folders recursively
    for (const folderId of folderIds) {
      const folderResult = await client.query(
        `SELECT id, parent_folder_id FROM folders 
         WHERE id = $1 AND user_id = $2`,
        [folderId, req.user.id]
      )

      if (folderResult.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(403).json({ 
          error: `Deletion error: Folder ${folderId} not found or access denied` 
        })
      }

      const folder = folderResult.rows[0]

      if (folder.parent_folder_id === null) {
        await client.query('ROLLBACK')
        return res.status(400).json({ 
          error: 'Deletion error: Cannot delete root folder' 
        })
      }

      await processFolderRecursive(folderId, { client, userId: req.user.id, trashPath, movedFiles, deletedFolders })
    }

    await client.query('COMMIT')

    res.json({ 
      success: true,
      moved: {
        files: movedFiles,
        folders: deletedFolders
      },
      message: `Moved ${movedFiles.length} file(s) to trash and removed ${deletedFolders.length} folder(s)`
    })

  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Delete error:', err)
    res.status(500).json({ error: 'Deletion error: Failed to move items to trash' })
  } finally {
    client.release()
  }
})



// ============= DOWNLOAD ==============================================================================================================================================
app.get('/api/files/:fileId/download', authenticateToken, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM files WHERE id = $1 AND user_id = $2',
      [req.params.fileId, req.user.id]
    )
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Download error: File not found' })
    }
    
    const file = result.rows[0]

    //does file exist on SSD?
    try {
      await fs.access(file.file_path)
    } catch (err) {
      console.error('Download error:', err)
      return res.status(404).json({ error: 'Download error: File not found on disk' })
    }

    res.download(file.file_path, file.original_filename)
  } catch (err) {
    console.error('Download error:', err)
    res.status(500).json({ error: 'Download error: Download failed' })
  }
})



// ============= MOVE FILES AND FOLDERS ========================================================================================================================================
app.post('/api/move', authenticateToken, async (req: Request, res: Response) => {
  const { fileIds = [], folderIds = [], targetFolderId } = req.body

  if (!targetFolderId || !Number.isInteger(Number(targetFolderId))) {
    return res.status(400).json({ error: 'Moving error: Target folder id not provided or is not an integer' })
  }

  if (fileIds.length === 0 && folderIds.length === 0) {
    return res.status(400).json({ error: 'Moving error: No items to move' })
  }
  //parse to avoit type errors
  const targetFolderIdInt = parseInt(targetFolderId)
  const folderIdsInt = folderIds.map((id: string) => parseInt(id))

  //get target folder info
  try {
    const targetFolder = await db.query(
      'SELECT * FROM folders WHERE id = $1 AND user_id = $2',
      [targetFolderIdInt, req.user.id]
    )

    if (targetFolder.rows.length === 0) {
      return res.status(404).json({ error: 'Moving error: Target folder not found' })
    }

    const targetPath = targetFolder.rows[0].path

    if (folderIds.length > 0) {
      const foldersToMove = await db.query(
        `SELECT id, path FROM folders WHERE id = ANY($1::int[]) AND user_id = $2`,
        [folderIdsInt, req.user.id]
      )

      for (const folder of foldersToMove.rows) {
        if (targetPath === folder.path || targetPath.startsWith(folder.path + '/')) {
          return res.status(400).json({
            error: `Moving error: Cannot move a folder into itself or one of its subfolders.`
          })
        }
      }
    }

    const client = await db.connect()
    try {
      await client.query('BEGIN')
      //if there are files to move
      if (fileIds.length > 0) {
        const filesCheck = await client.query(
          `SELECT id, file_path, filename FROM files
           WHERE id = ANY($1::int[]) AND user_id = $2 AND demo_file = FALSE`,
          [fileIds, req.user.id]
        )

        if (filesCheck.rows.length !== fileIds.length) {
          throw new Error('One or more files not found or not owned by user')
        }

        for (const file of filesCheck.rows) {
          const newFilePath = path.join('/app/storage', targetPath, file.filename)
          if (!newFilePath.startsWith('/app/storage/')) {
            return res.status(400).json({ error: 'Moving error: Invalid path' })
          }
          await fs.rename(file.file_path, newFilePath)
          await client.query(
            `UPDATE files SET folder_id = $1, file_path = $2
             WHERE id = $3`,
            [targetFolderIdInt, newFilePath, file.id]
          )
        }
      }

      if (folderIds.length > 0) {
        const foldersToMove = await client.query(
          `SELECT * FROM folders WHERE id = ANY($1::int[]) AND user_id = $2`,
          [folderIdsInt, req.user.id]
        )

        for (const folder of foldersToMove.rows) {
          const oldPath = folder.path
          const newPath = `${targetPath}/${folder.name}`

          await fs.rename(
            path.join('/app/storage', oldPath),
            path.join('/app/storage', newPath)
          )

          await client.query(
            `UPDATE folders SET parent_folder_id = $1, path = $2 WHERE id = $3`,
            [targetFolderIdInt, newPath, folder.id]
          )

          //update descendant folder paths with db paths
          await client.query(
            `UPDATE folders
             SET path = $2 || SUBSTRING(path FROM LENGTH($1) + 1)
             WHERE path LIKE $3 AND user_id = $4`,
            [oldPath, newPath, `${oldPath}/%`, req.user.id]
          )

          //update descendant file paths (physical)
          const oldPhysicalPath = path.join('/app/storage', oldPath)
          const newPhysicalPath = path.join('/app/storage', newPath)

          //update descendant file paths with physical paths
          await client.query(
            `UPDATE files
            SET file_path = $2 || SUBSTRING(file_path FROM LENGTH($1) + 1)
            WHERE file_path LIKE $3 AND user_id = $4`,
            [oldPhysicalPath, newPhysicalPath, `${oldPhysicalPath}/%`, req.user.id]
          )
        }
      }

      await client.query('COMMIT')
      res.json({ message: 'Items moved successfully' })

    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

  } catch (err) {
    console.error('Move error:', err)
    res.status(500).json({ error: 'Moving error: Failed to move items' })
  }
})



// ============= DEMO CLEANUP CRON =====================================================================================================================
async function wipeDemoUploads(): Promise<void> {
  const client = await db.connect()
  try {
    console.log('[Cron] Starting demo cleanup:', new Date().toISOString())

    //get all files
    const filesResult = await client.query(
      `SELECT id, file_path, thumbnail_path FROM files WHERE demo_file = FALSE`
    )

    //delete from disk
    let deletedCount = 0
    for (const file of filesResult.rows) {
      try {
        await fs.unlink(file.file_path).catch(() => {})
        if (file.thumbnail_path) {
          await fs.unlink(file.thumbnail_path).catch(() => {})
        }
      } catch (err) {
        console.error(`[Cron] Failed to delete file ${file.id}:`, err)
      }
    }

    //delete from db
    const deleteResult = await client.query(
      `DELETE FROM files WHERE demo_file = FALSE`
    )
    deletedCount = deleteResult.rowCount ?? 0

    //get folders (except root demo folder)
    const foldersResult = await client.query(
      `SELECT path FROM folders WHERE parent_folder_id IS NOT NULL`
    )
    //remove from disk
    for (const folder of foldersResult.rows) {
      const physicalPath = path.join('/app/storage', folder.path)
      await fs.rm(physicalPath, { recursive: true, force: true }).catch(() => {})
    }
    //remove from db
    await client.query(
      `DELETE FROM folders WHERE parent_folder_id IS NOT NULL`
    )

    console.log(`[Cron] Cleanup done. Deleted ${deletedCount} files.`)
  } catch (err) {
    console.error('[Cron] Cleanup failed:', err)
  } finally {
    client.release()
  }
}

//expose wipetime to frontend for timer
let nextWipeTime: Date | null = null
nextWipeTime = new Date(Date.now() + 30 * 60 * 1000)

app.get('/api/next-wipe', (req: Request, res: Response) => {
  res.json({ nextWipeAt: nextWipeTime })
})

/*
┌───── minute (0-59)
│ ┌─── hour (0-23)
│ │ ┌─ day of month (1-31)
│ │ │ ┌ month (1-12)
│ │ │ │ ┌ day of week (0-6, Sun=0)
│ │ │ │ │
* * * * *                          */

//  */30 * * * *   → every 30 minutes
//  0 * * * *      → every hour (on the hour)
//  0 0 * * *      → every day at midnight
//  0 9 * * 1      → every Monday at 9am


async function forceLogout(): Promise<void> {
  const client = await db.connect()
  try {
    console.log('[Cron] Logging users out:', new Date().toISOString())

    const deleteResult = await client.query(
      `DELETE FROM refresh_tokens`
    )

    console.log(`[Cron] All users logged out.`)
  } catch (err) {
    console.error('[Cron] Logouts failed:', err)
  } finally {
    client.release()
  }
}

cron.schedule('*/30 * * * *', () => {
  nextWipeTime = new Date(Date.now() + 30 * 60 * 1000)
  wipeDemoUploads()
  forceLogout()
})



// ============= TEST =============================================================================================================================================
//test endpoint
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT NOW()')
    res.json({ 
      status: 'ok', 
      database: 'connected',
      time: result.rows[0].now 
    })
  } catch (err) {
    res.status(500).json({ 
      status: 'error', 
      database: 'disconnected',
      error: (err as Error).message 
    })
  }
})

app.listen(port, '0.0.0.0', () => { //port is where clients connect, 0000 listens to all networks
  console.log(`Server running on port ${port}`)
})