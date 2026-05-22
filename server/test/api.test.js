import request from 'supertest';
import app from '../index.js';

describe('API Endpoints', () => {
  it('POST /api/analyze requires url parameter', async () => {
    const res = await request(app).post('/api/analyze').send({});
    expect(res.statusCode).toEqual(400);
    expect(res.body).toHaveProperty('error');
  });

  it('GET /api/mission/:id returns 404 for unknown mission', async () => {
    const res = await request(app).get('/api/mission/invalid_id');
    expect(res.statusCode).toEqual(404);
  });
});
