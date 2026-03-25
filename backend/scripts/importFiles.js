const { Pool } = require('pg')
const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const sharp = require('sharp') //thumbnail generation

const db = new Pool({ connectionString: process.env.DATABASE_URL })
const STORAGE_ROOT = '/app/storage'
const USERNAME = 'testuser' //CHANGE USER HERE

async function getOrCreateFolder(client, userId, folderPath, folderName, parentId) {
  const existing = await client.query(
    'SELECT id FROM folders WHERE user_id = $1 AND path = $2',
    [userId, folderPath]
  )
  if (existing.rows.length > 0) return existing.rows[0].id

  const result = await client.query(
    'INSERT INTO folders (user_id, name, parent_folder_id, path) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, folderName, parentId, folderPath]
  )
  return result.rows[0].id
}

async function scanDirectory(client, userId, physicalPath, dbPath, parentFolderId) {
  const entries = await fs.readdir(physicalPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPhysicalPath = path.join(physicalPath, entry.name)
    const entryDbPath = `${dbPath}/${entry.name}`

    if (entry.isDirectory()) {
      const folderId = await getOrCreateFolder(
        client, userId, entryDbPath, entry.name, parentFolderId
      )
      //recurse
      await scanDirectory(client, userId, entryPhysicalPath, entryDbPath, folderId)

    } else if (entry.isFile()) {
      //check if already in db (so the script is safe to re-run)
      const existing = await client.query(
        'SELECT id FROM files WHERE user_id = $1 AND file_path = $2',
        [userId, entryPhysicalPath]
      )
      if (existing.rows.length > 0) continue

      const stat = await fs.stat(entryPhysicalPath)
      const ext = path.extname(entry.name)
      const mime = getMime(ext)

      await client.query(
        `INSERT INTO files (user_id, filename, original_filename, file_path, file_size, folder_id, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, entry.name, entry.name, entryPhysicalPath, stat.size, parentFolderId, mime]
      )
      console.log('imported:', entryPhysicalPath)
    }
  }
}

function getMime(ext) {
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
    '.mov': 'video/quicktime', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.json': 'application/json',
    '.mp3': 'audio/mpeg', '.zip': 'application/zip',
  }
  return map[ext.toLowerCase()] || 'application/octet-stream'
}

//generate the thumbnails for images with sharp
async function generateThumbnail(filePath, mimeType, username){
  if (!mimeType.startsWith('image/')) return null

  const thumbnailDir = `/app/storage/thumbnails/${username}`
  await fs.mkdir(thumbnailDir, { recursive: true })

  const thumbnailPath = path.join(thumbnailDir, `${crypto.randomUUID()}.webp`)

  try {
    await sharp(filePath)
      .resize(200, 200, { fit: 'cover', position: 'centre' })
      .webp({ quality: 70 })
      .toFile(thumbnailPath)

    return thumbnailPath
  } catch (err) {
    console.warn(`Skipping thumbnail for ${filePath}: ${err.message}`)
    return null
  }
}

async function main() {
  const client = await db.connect()

  //import files into DB
  try {
    const userResult = await client.query(
      'SELECT id FROM users WHERE username = $1', [USERNAME]
    )
    if (userResult.rows.length === 0) throw new Error(`User ${USERNAME} not found`)
    const userId = userResult.rows[0].id

    const rootPath = `/${USERNAME}`
    const physicalRoot = path.join(STORAGE_ROOT, rootPath)

    const rootFolder = await client.query(
      'SELECT id FROM folders WHERE user_id = $1 AND parent_folder_id IS NULL', [userId]
    )
    const rootFolderId = rootFolder.rows[0].id

    await client.query('BEGIN')
    await scanDirectory(client, userId, physicalRoot, rootPath, rootFolderId)
    await client.query('COMMIT')
    console.log('Import complete')
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('Import failed:', err)
    client.release()
    await db.end()
    return
  }

  //generate thumbnails (outside transaction, failures are not fatal)
  try {
    const userId = (await client.query(
      'SELECT id FROM users WHERE username = $1', [USERNAME]
    )).rows[0].id

    const filesToThumb = await client.query(
      `SELECT id, file_path, mime_type FROM files 
       WHERE user_id = $1 AND thumbnail_path IS NULL AND mime_type LIKE 'image/%'`,
      [userId]
    )

    for (const file of filesToThumb.rows) {
      const thumbnailPath = await generateThumbnail(file.file_path, file.mime_type, USERNAME)
      if (thumbnailPath) {
        await client.query(
          'UPDATE files SET thumbnail_path = $1 WHERE id = $2',
          [thumbnailPath, file.id]
        )
        console.log('thumbnail generated:', file.file_path)
      }
    }
  } catch (err) {
    console.error('Thumbnail generation failed:', err)
  } finally {
    client.release()
    await db.end()
  }
}

main()