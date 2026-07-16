import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app, db } from '../../app'

describe('REGISTRATION: POST /api/auth/register', () => {
  afterAll(async () => {
    await db.query('DELETE FROM users WHERE username = $1', ['testuser_registration'])
  })

  it('registers a new user with valid admin secret', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('x-admin-secret', process.env.ADMIN_SECRET as string)
      .send({ username: 'testuser_registration', password: 'password123' })

    expect(res.status).toBe(201)
  })

  it('rejects registration without admin secret', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'testuser_registration2', password: 'password123' })

    expect(res.status).toBe(403)
  })

  it('rejects registration with a duplicated username', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('x-admin-secret', process.env.ADMIN_SECRET as string)
      .send({ username: 'testuser_registration', password: 'password123' })

    expect(res.status).toBe(409)
  })
})



describe('LOGIN: POST /api/auth/login', () => {
  const testUser = 'testuser_login'
  const testPassword = 'password123'

  beforeAll(async () => {
    await request(app)
    .post('/api/auth/register')
    .set('x-admin-secret', process.env.ADMIN_SECRET as string)
    .send({ username: testUser, password: testPassword })
  })

  afterAll(async () => {
    await db.query('DELETE FROM users WHERE username = $1', ['testuser_login'])
  })

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
    await request(app)
      .post('/api/auth/register')
      .set('x-admin-secret', process.env.ADMIN_SECRET as string)
      .send({ username: testUser, password: testPassword })

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: testUser, password: testPassword })

    validToken = loginRes.body.accessToken
  })

  afterAll(async () => {
    await db.query('DELETE FROM users WHERE username = $1', [testUser])
  })

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
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '-10s' } // already expired
    )

    const res = await request(app)
      .get('/api/folders/all')
      .set('Authorization', `Bearer ${expiredToken}`)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid or expired token')
  })

  it('rejects a validly-signed token for a user that no longer exists', async () => {
    const tokenForGhostUser = jwt.sign(
      { sub: 999999 }, // an id that shouldn't exist
      process.env.JWT_SECRET as string,
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