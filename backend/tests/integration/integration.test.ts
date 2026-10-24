import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import fs from 'fs/promises'
import path from 'path'
import { app, db } from '../../app'

const ADMIN_SECRET = process.env.ADMIN_SECRET as string
const JWT_SECRET = process.env.JWT_SECRET as string

//removes a test user from db and disk. Children first, because the FKs are not CASCADE.
//Safe to call when the user doesn't exist.
async function deleteTestUser(username: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const u = await client.query('SELECT id FROM users WHERE username = $1', [username])
    if (u.rows.length > 0) {
      const id = u.rows[0].id
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [id])
      await client.query('DELETE FROM files WHERE user_id = $1', [id])
      await client.query('DELETE FROM folders WHERE user_id = $1', [id])
      await client.query('DELETE FROM users WHERE id = $1', [id])
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  //register creates /app/storage/<username>, uploads may create thumbnails/<username>
  await fs.rm(path.join('/app/storage', username), { recursive: true, force: true })
  await fs.rm(path.join('/app/storage/thumbnails', username), { recursive: true, force: true })
}

async function registerUser(username: string, password: string) {
  return request(app)
    .post('/api/auth/register')
    .set('x-admin-secret', ADMIN_SECRET)
    .send({ username, password })
}



describe('REGISTRATION: POST /api/auth/register', () => {
  const testUser = 'testuser_registration'

  beforeAll(() => deleteTestUser(testUser)) //clear leftovers from a crashed run
  afterAll(() => deleteTestUser(testUser))

  it('registers a new user with valid admin secret', async () => {
    const res = await registerUser(testUser, 'password123')

    expect(res.status).toBe(201)
  })

  it('rejects registration without admin secret', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_registration2', password: 'password123' })

    expect(res.status).toBe(403)
  })

  it('rejects registration with a duplicated username', async () => {
    const res = await registerUser(testUser, 'password123')

    expect(res.status).toBe(409)
  })
})



describe('LOGIN: POST /api/auth/login', () => {
  const testUser = 'testuser_login'
  const testPassword = 'password123'

  beforeAll(async () => {
    await deleteTestUser(testUser)
    await registerUser(testUser, testPassword)
  })

  afterAll(() => deleteTestUser(testUser))

  it('rejects login with incorrect password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: testUser, password: 'wrongpassword' })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Login error: Invalid credentials')
  })

  it('rejects login with non-existent user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'fake_user', password: testPassword })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Login error: Invalid credentials')
  })

  it('correct login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: testUser, password: testPassword })

    expect(res.status).toBe(200)
    expect(res.body.message).toBe('Login successful')
    expect(res.body.accessToken).toEqual(expect.any(String))
    expect(res.body.user).toEqual({ id: expect.any(Number), username: testUser })
  })
})



describe('AUTH TOKEN MIDDLEWARE: GET /api/folders/all', () => {
  const testUser = 'testuser_authmw'
  const testPassword = 'password123'
  let validToken: string

  beforeAll(async () => {
    await deleteTestUser(testUser)
    await registerUser(testUser, testPassword)

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: testUser, password: testPassword })

    validToken = loginRes.body.accessToken
  })

  afterAll(() => deleteTestUser(testUser))

  it('rejects requests with no token', async () => {
    const res = await request(app).get('/api/folders/all')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Access token required')
  })

  it('rejects requests with a malformed authorization header', async () => {
    const res = await request(app)
      .get('/api/folders/all')
      .set('Authorization', 'NotBearerFormat')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Access token required')
  })

  it('rejects requests with an invalid/garbage token', async () => {
    const res = await request(app)
      .get('/api/folders/all')
      .set('Authorization', 'Bearer this.is.not.a.valid.jwt')

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid or expired token')
  })

  it('rejects an expired token', async () => {
    const expiredToken = jwt.sign(
      { sub: 1 },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '-10s' }
    )

    const res = await request(app)
      .get('/api/folders/all')
      .set('Authorization', `Bearer ${expiredToken}`)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid or expired token')
  })

  it('rejects a validly-signed token for a user that no longer exists', async () => {
    const tokenForGhostUser = jwt.sign(
      { sub: 999999 },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '5m' }
    )

    const res = await request(app)
      .get('/api/folders/all')
      .set('Authorization', `Bearer ${tokenForGhostUser}`)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('User not found')
  })

  it('accepts a valid token and proceeds to the route', async () => {
    const res = await request(app)
      .get('/api/folders/all')
      .set('Authorization', `Bearer ${validToken}`)

    expect(res.status).toBe(200)
    expect(res.body.folders).toBeDefined()
  })
})



afterAll(async () => {
  await db.end()
})