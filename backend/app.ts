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

//the object passed into processFolderRecursive
//PoolClient is pg's type for a checked-out DB connection
import type { PoolClient } from 'pg'
import { validateFolderName, validateStoragePath, validateUsername } from './validators'

interface RecursiveSoftDeleteContext {
  client: PoolClient
  userId: number
  movedFiles: Array<{ id: number; name: string }>
  deletedFolders: number[]
}



//===============================================================================================================================================

const app = express()
app.set('trust proxy', 1)

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : []

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

//no page indexing server-level as it's a open Demo
app.use((req: Request, res: Response, next: NextFunction) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(express.json())  //parse JSON request bodies -> reads request, parses JSON and turns it into a js object attaching it to req.body
app.use(cookieParser()) //HTTP only cookies against XSS(Cross-site scripting)

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
//extract token from req auth headers
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



// ============= REGISTRATION ==================================================================================================================
//requires admin secret —> not a public endpoint, no rate limit needed
app.post('/api/auth/register', async (req: Request, res: Response) => {
//check admin secret
  const adminSecret = req.headers['x-admin-secret']
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Registration is not open' })
  }
  try {
    const { username, password } = req.body as {username: string; password: string} 

  //credentials validation
    if (!username || !password) {
      return res.status(400).json({ error: 'All fields required' }) 
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' }) 
    }

    if (!validateUsername(username)) {
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
    if (!validateStoragePath(userDir)) {
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
//receive credentials
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
//get current REFRESH token (30days) from cookies
  const refreshToken = req.cookies.refreshToken

  if (!refreshToken) {
    return res.status(401).json({ error: 'No refresh token' })
  }

//turn cookie into hash and compare with db
  try {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
    //createHash makes an object that can transform strings using the sha256 algorithm (hash instance)
    //update feeds `refreshToken` to the hash object
    //digest finalizes the process and picks the encoding (hex)

    //is this token still valid and not expired?
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
//create new JWT ACCESS token (5min)
    const { user_id, username } = result.rows[0]

    const accessToken = jwt.sign(
      { sub: user_id },
      JWT_SECRET,
      { expiresIn: '5m', algorithm: 'HS256' }
    )
//send to browser
    res.json({ accessToken, user: { id: user_id, username } })
  } catch (err) {
    console.error('Refresh error:', err)
    res.status(500).json({ error: 'Failed to refresh token' })
  }
})



//================== LOGOUT ==================================================================================================================================
app.post('/api/auth/logout', async (req: Request, res: Response) => {
  try {
//delete refresh token from DB
    const refreshToken = req.cookies.refreshToken

    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex')
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
        'SELECT path FROM folders WHERE id = $1 AND user_id = $2 AND deleted = FALSE',
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
    const physicalPath = path.join('/app/storage', fullPath)
    if (!validateStoragePath(physicalPath)) {
      return res.status(400).json({ error: 'Error making a new folder: Invalid path' })
    }
    
    //insert into db
    let result
    try {
      result = await db.query(
      'INSERT INTO folders (user_id, name, parent_folder_id, path) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, name, parentFolderId || null, fullPath]
    )} catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'A folder with that name already exists here' })
      }
      throw err
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
       WHERE user_id = $1 AND deleted = FALSE ORDER BY path`,
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
      WHERE id = $1 AND user_id = $2 AND deleted = FALSE`,
      [folderId, req.user.id]
    ) 
    
    if (folderInfo.rows.length === 0) {
      return res.status(404).json({ error: 'Error listing folder contents: Folder not found' }) 
    }

    //get contents
    const [folders, files] = await Promise.all([
      db.query(
        `SELECT * FROM folders 
        WHERE user_id = $1 AND parent_folder_id = $2 AND deleted = FALSE
        ORDER BY name`,
        [req.user.id, folderId]
      ),
      db.query(
        `SELECT * FROM files 
        WHERE user_id = $1 AND folder_id = $2 AND deleted = FALSE
        ORDER BY created_at DESC, id DESC`,
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
          'SELECT path FROM folders WHERE id = $1 AND user_id = $2 AND deleted = FALSE',
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
      if (!validateStoragePath(physicalPath)) {
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
    const folderId = req.query.folderId
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
    'SELECT thumbnail_path, mime_type FROM files WHERE id = $1 AND user_id = $2 AND deleted = FALSE',
    [req.params.id, req.user.id]
  )

  if (!result.rows[0] || !result.rows[0].thumbnail_path) {
    return res.status(404).json({ error: 'No thumbnail available' })
  }

  res.set('Content-Type', 'image/webp')
  res.set('Cache-Control', 'no-store') //no cache (Demo only)
  res.sendFile(path.resolve(result.rows[0].thumbnail_path), { cacheControl: false })
})  



// ============ PREVIEW FILE ================================================================================================================================
app.get('/api/files/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!Number.isInteger(Number(req.params.id)))
      return res.status(400).json({error: 'Preview file error: The ID is not a valid integer'})
    const result = await db.query(
      'SELECT * FROM files WHERE id = $1 AND user_id = $2 AND deleted = FALSE',
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

//OLD DELETE LOGIC
//get some files    files = [file1, file2, file3]
// copy them to the trash folder (unaccessible by users)
//open db transaction and delete files from db)
    // something wrong? (eg. file3 can't be removed, because Demo file) -> rollback. Problem: the files were physically moved, now they show as broken for users
    // all good? -> close transaction.

//NEW SOFT DELETE LOGIC
//tag all the files as deleted=TRUE.
//display only deleted=FALSE on the frontend
//cleanup the disk periodically


async function processFolderRecursiveSoft(folderId: number, context: RecursiveSoftDeleteContext): Promise<void> {
  const {client, userId, movedFiles, deletedFolders} = context

  //delete all files in this folder
  const filesResult = await client.query(
    `SELECT id, file_path, filename, thumbnail_path FROM files 
      WHERE user_id = $1 AND folder_id = $2 AND demo_file = FALSE`,
    [userId, folderId]
  )

  for (const file of filesResult.rows) {
    try {

      await client.query(
        `UPDATE files SET deleted = TRUE WHERE id = $1 AND user_id = $2`,
        [file.id, userId]
      )
      
      movedFiles.push({ id: file.id, name: file.filename })
    } catch (err) {
      throw err
    }
  }

  try {
      await client.query(
        `UPDATE folders SET deleted = TRUE WHERE id = $1 AND user_id = $2`,
        [folderId, userId]
      )
      deletedFolders.push(folderId)
    } catch (err) {
      throw err
    }

  //recurse into subfolders
  const subfoldersResult = await client.query(
    `SELECT id FROM folders 
      WHERE user_id = $1 AND parent_folder_id = $2`,
    [userId, folderId]
  )

  for (const subfolder of subfoldersResult.rows) {
    await processFolderRecursiveSoft(subfolder.id, { client, userId, movedFiles, deletedFolders })
  }
}

app.delete('/api/softdelete', authenticateToken, async (req: Request, res: Response) => {
  const client = await db.connect()
  
  try {
//validate files and folders
    const { fileIds = [], folderIds = [] } = req.body
    
    if (!Array.isArray(fileIds) || !Array.isArray(folderIds)) {
      return res.status(400).json({ error: 'Deletion error: fileIds and folderIds must be arrays' })
    }

    if (fileIds.length === 0 && folderIds.length === 0) {
      return res.status(400).json({ error: 'Deletion error: No items selected for deletion' })
    }
//open db transaction
    await client.query('BEGIN')

    let movedFiles: Array<{ id: number; name: string }> = []
    let deletedFolders: number[] = []

//select files
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
//set files to deleted
      try {

        await client.query(
          `UPDATE files SET deleted = TRUE WHERE id = $1 AND user_id = $2`,
          [fileId, req.user.id]
        )

        movedFiles.push({ id: fileId, name: file.filename })
      } catch (err) {
        console.error(`Delete error: Failed to move file to trash:`, err)
        await client.query('ROLLBACK')
        return res.status(500).json({ error: 'Deletion error: Failed to move file to trash' })
      }
    }

//select folders
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
//recursively set folder and subfolders to deleted
      await processFolderRecursiveSoft(folderId, { client, userId: req.user.id, movedFiles, deletedFolders })
    }
//commit
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
//release
    client.release()
  }
})



// ============= DOWNLOAD ==============================================================================================================================================
app.get('/api/files/:fileId/download', authenticateToken, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT * FROM files WHERE id = $1 AND user_id = $2 AND deleted = FALSE',
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
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

//returns a deduplicated array of positive integers, or null if the input is invalid
function toIdArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null
  if (!v.every(x => typeof x === 'number' || typeof x === 'string')) return null
  const ids = v.map(Number)
  if (!ids.every(n => Number.isInteger(n) && n > 0)) return null
  return [...new Set(ids)]
}

//best-effort reversal of disk moves when the transaction fails
async function undoRenames(renames: Array<{ from: string; to: string }>): Promise<void> {
  for (const { from, to } of [...renames].reverse()) {
    await fs.rename(to, from).catch(err =>
      console.error(`Move rollback error: could not restore ${to} -> ${from}:`, err)
    )
  }
}

app.post('/api/move', authenticateToken, async (req: Request, res: Response) => {
  //validation before touching the db
  const { fileIds: rawFileIds = [], folderIds: rawFolderIds = [], targetFolderId } = req.body ?? {}

  const fileIds = toIdArray(rawFileIds)
  const folderIds = toIdArray(rawFolderIds)

  if (!fileIds || !folderIds) {
    return res.status(400).json({ error: 'Moving error: fileIds and folderIds must be arrays of integers' })
  }
  if (fileIds.length === 0 && folderIds.length === 0) {
    return res.status(400).json({ error: 'Moving error: No items to move' })
  }
  if (!targetFolderId || !Number.isInteger(Number(targetFolderId))) {
    return res.status(400).json({ error: 'Moving error: Target folder id not provided or is not an integer' })
  }
  const targetFolderIdInt = Number(targetFolderId)

  const renames: Array<{ from: string; to: string }> = [] //disk moves done so far, to undo on failure

  try {
    const client = await db.connect()

    try {
      await client.query('BEGIN')

      //---------- target folder ----------
      const targetResult = await client.query(
        'SELECT id, path FROM folders WHERE id = $1 AND user_id = $2 AND deleted = FALSE',
        [targetFolderIdInt, req.user.id]
      )
      if (targetResult.rows.length === 0) {
        throw new HttpError(404, 'Moving error: Target folder not found')
      }
      const targetPath: string = targetResult.rows[0].path

      //---------- files ----------
      if (fileIds.length > 0) {
        const filesCheck = await client.query(
          `SELECT id, file_path, filename FROM files
           WHERE id = ANY($1::int[]) AND user_id = $2 AND demo_file = FALSE AND deleted = FALSE`,
          [fileIds, req.user.id]
        )

        if (filesCheck.rows.length !== fileIds.length) {
          throw new HttpError(404, 'Moving error: One or more files not found or cannot be moved')
        }

        for (const file of filesCheck.rows) {
          const newFilePath = path.join('/app/storage', targetPath, file.filename)
          if (!validateStoragePath(newFilePath)) {
            throw new HttpError(400, 'Moving error: Invalid path')
          }
          if (file.file_path === newFilePath) continue //already in the target folder

          await fs.rename(file.file_path, newFilePath)
          renames.push({ from: file.file_path, to: newFilePath })

          await client.query(
            `UPDATE files SET folder_id = $1, file_path = $2
             WHERE id = $3 AND user_id = $4`,
            [targetFolderIdInt, newFilePath, file.id, req.user.id]
          )
        }
      }

      //---------- folders ----------
      if (folderIds.length > 0) {
        const foldersToMove = await client.query(
          `SELECT id, name, path, parent_folder_id FROM folders
           WHERE id = ANY($1::int[]) AND user_id = $2 AND deleted = FALSE`,
          [folderIds, req.user.id]
        )

        if (foldersToMove.rows.length !== folderIds.length) {
          throw new HttpError(404, 'Moving error: One or more folders not found')
        }

        //checks that apply to the whole selection, before moving anything
        for (const folder of foldersToMove.rows) {
          if (folder.parent_folder_id === null) {
            throw new HttpError(400, 'Moving error: Cannot move a root folder')
          }
          if (targetPath === folder.path || targetPath.startsWith(folder.path + '/')) {
            throw new HttpError(400, 'Moving error: Cannot move a folder into itself or one of its subfolders')
          }
          for (const other of foldersToMove.rows) {
            if (other.id !== folder.id && other.path.startsWith(folder.path + '/')) {
              throw new HttpError(400, 'Moving error: Cannot move a folder together with one of its subfolders')
            }
          }
        }

        for (const folder of foldersToMove.rows) {
          const oldPath: string = folder.path
          const newPath = `${targetPath}/${folder.name}`

          if (oldPath === newPath) continue //already in the target folder

          const clash = await client.query(
            `SELECT 1 FROM folders
             WHERE user_id = $1 AND parent_folder_id = $2 AND name = $3 AND id <> $4 AND deleted = FALSE
             LIMIT 1`,
            [req.user.id, targetFolderIdInt, folder.name, folder.id]
          )
          if (clash.rows.length > 0) {
            throw new HttpError(409, `Moving error: A folder named "${folder.name}" already exists in the target folder`)
          }

          const oldPhysicalPath = path.join('/app/storage', oldPath)
          const newPhysicalPath = path.join('/app/storage', newPath)
          if (!validateStoragePath(oldPhysicalPath) || !validateStoragePath(newPhysicalPath)) {
            throw new HttpError(400, 'Moving error: Invalid path')
          }

          await fs.rename(oldPhysicalPath, newPhysicalPath)
          renames.push({ from: oldPhysicalPath, to: newPhysicalPath })

          //the moved folder itself
          await client.query(
            `UPDATE folders SET parent_folder_id = $1, path = $2
             WHERE id = $3 AND user_id = $4`,
            [targetFolderIdInt, newPath, folder.id, req.user.id]
          )

          //descendant folders (db paths). Exact prefix compare instead of LIKE, so "_" is not a wildcard
          await client.query(
            `UPDATE folders
             SET path = $2::text || SUBSTRING(path FROM LENGTH($1::text) + 1)
             WHERE left(path, LENGTH($1::text) + 1) = $1::text || '/' AND user_id = $3`,
            [oldPath, newPath, req.user.id]
          )

          //descendant files (physical paths), same exact-prefix approach
          await client.query(
            `UPDATE files
             SET file_path = $2::text || SUBSTRING(file_path FROM LENGTH($1::text) + 1)
             WHERE left(file_path, LENGTH($1::text) + 1) = $1::text || '/' AND user_id = $3`,
            [oldPhysicalPath, newPhysicalPath, req.user.id]
          )
        }
      }

      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(e => console.error('Move ROLLBACK error:', e))
      await undoRenames(renames) //put files/folders back where they were on disk
      throw err
    } finally {
      client.release()
    }

    res.json({ message: 'Items moved successfully' })
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message })
    }
    const code = (err as { code?: string }).code
    if (code === '23505') {
      //the unique index caught a race the clash query missed
      return res.status(409).json({ error: 'Moving error: A folder with that name already exists in the target' })
    }
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      //target path still holds the directory of a soft-deleted folder that wasn't purged yet
      return res.status(409).json({ error: 'Moving error: Target location is still being cleaned up, try again later' })
    }
    console.error('Move error:', err)
    res.status(500).json({ error: 'Moving error: Failed to move items' })
  }
})

// ============ DEMO CLEANUP =====================================================================================================================================================
//Every 30 mins on the Demo I remove all uploaded files, keep only the ones I selected (Demo_file=TRUE), force every user to logout.
//I separated disk operations from db operations.

// ============================ CLEAN DB ==========================================================================================================================

//Delete from db files and folders that are not part of the demo, have been deleted by users and (for folders) are not the user's Root folder.
async function cleanDemoDb(): Promise<void> {
  const client = await db.connect()
  try {
    console.log('[Cron] Starting DB cleanup:', new Date().toISOString())

//delete files from db
    const deletedFiles = await client.query(
      `DELETE FROM files WHERE demo_file = FALSE`
    )
    const deletedFilesNr = deletedFiles.rowCount ?? 0

//remove folders from db
    const deletedFolders = await client.query(
      `DELETE FROM folders WHERE parent_folder_id IS NOT NULL`
    )

    const deletedFoldersNr = deletedFolders.rowCount ?? 0

    console.log(`[Cron] DB cleanup done. Deleted ${deletedFilesNr} files rows and ${deletedFoldersNr} folders rows.`)
  } catch (err) {
    console.error('[Cron] Cleanup failed:', err)
    throw err
  } finally {
    client.release()
  }
}

// ============= PERMANENTLY DELETE FILES FROM DISK ==============================================================================================================

//Delete from disk files and folders that are not part of the Demo.
async function cleanDemoDisk(): Promise<void> {
  const client = await db.connect()
  try {
    console.log('[Cron] Starting disk cleanup:', new Date().toISOString())

//get all files
    const filesResult = await client.query(
      `SELECT id, file_path, thumbnail_path FROM files WHERE demo_file = FALSE`
    )

//delete from disk
    let deletedCount = 0
    for (const file of filesResult.rows) {
      try {
        await fs.unlink(file.file_path)
        if (file.thumbnail_path) {
          await fs.unlink(file.thumbnail_path)
        }
        deletedCount++
      } catch (err:any) {
        //If the file already doesn't exist is fine, else throw an error
        if (err.code !== 'ENOENT') {
          console.error(`[Cron] Failed to delete file ${file.id}:`, err)
          throw err
        }
      }
    }

//get all folders (except root demo folder)
    const foldersResult = await client.query(
      `SELECT path FROM folders WHERE parent_folder_id IS NOT NULL`
    )
    //remove from disk
    for (const folder of foldersResult.rows) {
      try {
        const physicalPath = path.join('/app/storage', folder.path)
        await fs.rm(physicalPath, { recursive: true, force: true })
      } catch (err) {
        console.error(`[Cron] Failed to delete folder ${folder.path}:`, err)
      }
    }

    console.log(`[Cron] Cleanup done. Deleted ${deletedCount} files and unused folders.`)
  } catch (err) {
    console.error('[Cron] Cleanup failed:', err)
    throw err
  } finally {
    client.release()
  }
}

// =========================== FORCE LOGOUT =========================================================================================

async function forceLogout(): Promise<void> {
  const client = await db.connect()
  try {
    console.log('[Cron] Logging users out:', new Date().toISOString())

    await client.query(
      `DELETE FROM refresh_tokens`
    )

    console.log(`[Cron] All users logged out.`)
  } catch (err) {
    console.error('[Cron] Logouts failed:', err)
    throw err
  } finally {
    client.release()
  }
}

// ============= DEMO CLEANUP CRON =====================================================================================================================
//Order matters.
async function cleanDemo(): Promise<void> {
  try {
    await cleanDemoDisk()
    await cleanDemoDb()
    await forceLogout()
  } catch (err) {
    console.error('[Cron] Demo cleanup failed:', err)
    throw err
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


cron.schedule('*/30 * * * *', () => {
  nextWipeTime = new Date(Date.now() + 30 * 60 * 1000) //30min
  cleanDemo().catch(err => console.error('[Cron] cleanDemo failed', err))
})


// ============ APP CLEANUP =====================================================================================================================================================
//This never happens on the Demo, only in the actual App.
//Every 24 hrs I remove all the files the user deleted from both disk and db.
//I separated disk operations from db operations.

// ============================ CLEAN DB ==========================================================================================================================

//Delete from db files and folders that users deleted.
async function cleanDb(): Promise<void> {
  const client = await db.connect()
  try {
    console.log('[Cron] Starting DB cleanup:', new Date().toISOString())

//delete files from db
    const deletedFiles = await client.query(
      `DELETE FROM files WHERE deleted = TRUE`
    )
    const deletedFilesNr = deletedFiles.rowCount ?? 0

//remove folders from db
    const deletedFolders = await client.query(
      `DELETE FROM folders WHERE parent_folder_id IS NOT NULL AND deleted = TRUE`
    )

    const deletedFoldersNr = deletedFolders.rowCount ?? 0

    console.log(`[Cron] DB cleanup done. Deleted ${deletedFilesNr} files rows and ${deletedFoldersNr} folders rows.`)
  } catch (err) {
    console.error('[Cron] Cleanup failed:', err)
    throw err
  } finally {
    client.release()
  }
}

// ============= PERMANENTLY DELETE FILES FROM DISK ==============================================================================================================

//Delete from disk files and folders that users deleted.

async function cleanDisk(): Promise<void> {
  const client = await db.connect()
  try {
    console.log('[Cron] Starting disk cleanup:', new Date().toISOString())

    //1) files: remove each file and its thumbnail independently
    const rm = (p: string) =>
      fs.rm(p, { force: true }).catch(e => console.error('[Cron] rm failed', p, e))

    const filesResult = await client.query(
      `SELECT id, file_path, thumbnail_path FROM files WHERE deleted = TRUE`
    )
    for (const file of filesResult.rows) {
      await rm(file.file_path)
      if (file.thumbnail_path) await rm(file.thumbnail_path)
    }

    //2) folders: only remove empty directories nobody live is using
    const liveRes = await client.query(`SELECT path FROM folders WHERE deleted = FALSE`)
    const livePaths = new Set<string>(liveRes.rows.map(r => r.path))

    const deadRes = await client.query(
      `SELECT path FROM folders WHERE parent_folder_id IS NOT NULL AND deleted = TRUE`
    )
    const deadPaths: string[] = deadRes.rows
      .map(r => r.path as string)
      .filter(p => !livePaths.has(p))
      .sort((a, b) => b.length - a.length) //children before parents

    for (const p of deadPaths) {
      const physical = path.join('/app/storage', p)
      if (!validateStoragePath(physical)) continue
      try {
        await fs.rmdir(physical)
      } catch (e: any) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') {
          console.error('[Cron] rmdir failed', p, e)
        }
      }
    }

    console.log(`[Cron] Disk cleanup done. Processed ${filesResult.rows.length} files and ${deadPaths.length} folders.`)
  } catch (err) {
    console.error('[Cron] Disk cleanup failed:', err)
    throw err
  } finally {
    client.release()
  }
}

// ============= ROUTINE CLEANUP CRON =====================================================================================================================

async function cleanApp(): Promise<void> {
  try {
    await cleanDisk()
    await cleanDb()
  } catch (err) {
    console.error('[Cron] Disk cleanup failed:', err)
    throw err
  }
}

//NOT ON DEMO
//cron.schedule('0 3 * * *', () => {
//  cleanApp().catch(err => console.error('[Cron] cleanApp failed', err))
//})


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

export {db}
export {app}