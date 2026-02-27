import 'dotenv/config';
import Fastify from 'fastify';
import pkg from 'pg';
import { AccessToken } from 'livekit-server-sdk';

const { Pool } = pkg;

const app = Fastify({ logger: true });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

function grantsForRole(role) {
  if (role === 'listener') return { canPublish: false, canSubscribe: true };
  return { canPublish: true, canSubscribe: true };
}

app.get('/health', async () => {
  const r = await pool.query('SELECT 1 as ok');
  return { ok: true, db: r.rows[0].ok === 1 };
});

app.post('/livekit/token', async (req, reply) => {
  try {
    const { roomSlug, userEmail } = req.body || {};
    if (!roomSlug || !userEmail) {
      return reply.code(400).send({ error: 'roomSlug and userEmail are required' });
    }

    const u = await pool.query(
      `SELECT id, display_name, email
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [userEmail]
    );

    if (!u.rowCount) return reply.code(404).send({ error: 'user not found' });
    const user = u.rows[0];

    const r = await pool.query(
      `SELECT id, livekit_room, status
       FROM rooms
       WHERE slug = $1
       LIMIT 1`,
      [roomSlug]
    );

    if (!r.rowCount) return reply.code(404).send({ error: 'room not found' });
    const room = r.rows[0];

    if (room.status !== 'live') {
      return reply.code(400).send({ error: 'room is not live' });
    }

    const m = await pool.query(
      `SELECT role, is_banned
       FROM room_members
       WHERE room_id = $1 AND user_id = $2
       LIMIT 1`,
      [room.id, user.id]
    );

    let role = 'listener';
    if (m.rowCount) {
      if (m.rows[0].is_banned) return reply.code(403).send({ error: 'banned' });
      role = m.rows[0].role;
    }

    const { canPublish, canSubscribe } = grantsForRole(role);

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: user.id,
        name: user.display_name,
      }
    );

    at.addGrant({
      roomJoin: true,
      room: room.livekit_room,
      canPublish,
      canSubscribe,
    });

    const token = await at.toJwt();

    return reply.send({
      livekitUrl: process.env.LIVEKIT_URL,
      token,
      role,
    });
  } catch (e) {
    console.error(e);
    return reply.code(500).send({ error: String(e.message) });
  }
});

app.listen({ port: 3000, host: '0.0.0.0' });