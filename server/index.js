const pool = require("./db");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

allowedOrigins.push("http://localhost:5173");
allowedOrigins.push("http://localhost:3000");

console.log("✅ Allowed origins:", allowedOrigins);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("❌ CORS blocked origin:", origin);
      return callback(null, false);
    },
    credentials: true,
  })
);

app.options("*", cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Environment variables
const PORT = process.env.PORT || 10000;
const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT || "http://localhost/v1";
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID || "";

// In-memory tracking
const onlineUsers = new Map(); // userId -> Set of WebSocket connections
const rooms = new Map(); // roomId -> Set of WebSocket connections

console.log('🚀 Starting chat server...');
console.log('📡 Appwrite:', APPWRITE_ENDPOINT);
console.log('📦 Project:', APPWRITE_PROJECT_ID);

// ====================================
// REST API ENDPOINTS
// ====================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    uptime: process.uptime(),
    onlineUsers: onlineUsers.size,
    activeRooms: rooms.size
  });
});

/**
 * Search users by email
 */
app.get('/api/users/search', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email parameter required' });
    }

    const result = await pool.query(
      'SELECT id, email, name, status FROM users WHERE email ILIKE $1 LIMIT 10',
      [`%${email}%`]
    );
    
    res.json({ users: result.rows });
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * Get user's rooms with unread counts
 */
app.get("/api/rooms", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "userId parameter required" });
    }

    const result = await pool.query(
      `
      SELECT 
        r.id,
        r.name,
        r.type,
        r.updated_at,

        COUNT(m.id) FILTER (
          WHERE m.created_at > rm.last_read_at AND m.deleted = FALSE
        ) AS unread_count,

        MAX(m.created_at) AS last_message_at,

        -- DM partner (other member)
        u2.id AS dm_user_id,
        u2.email AS dm_email,
        u2.name AS dm_name

      FROM rooms r
      JOIN room_members rm ON r.id = rm.room_id

      LEFT JOIN messages m ON r.id = m.room_id

      LEFT JOIN room_members rm2
        ON r.id = rm2.room_id
       AND rm2.user_id != $1

      LEFT JOIN users u2 ON u2.id = rm2.user_id

      WHERE rm.user_id = $1

      GROUP BY
        r.id, r.name, r.type, r.updated_at,
        rm.last_read_at,
        u2.id, u2.email, u2.name

      ORDER BY last_message_at DESC NULLS LAST
    `,
      [userId]
    );

    res.json({ rooms: result.rows });
  } catch (err) {
    console.error("Get rooms error:", err);
    res.status(500).json({ error: "Failed to get rooms" });
  }
});


/**
 * Get messages for a room (with pagination)
 */
app.get('/api/messages/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before; // timestamp for pagination
    
    let query = `
      SELECT 
        m.id, m.content, m.message_type, m.created_at, m.edited, m.sender_id,
        u.email as sender_email,
        u.name as sender_name
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.room_id = $1
        AND m.deleted = FALSE
    `;
    
    const params = [roomId];
    
    if (before) {
      query += ` AND m.created_at < $2`;
      params.push(before);
    }
    
    query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await pool.query(query, params);

    const normalized = result.rows.map((m) => ({
      id: m.id,
      roomId,
      senderId: m.sender_id,
      senderEmail: m.sender_email,
      senderName: m.sender_name,
      content: m.content,
      created_at: m.created_at,
      timestamp: new Date(m.created_at).getTime(),
    }));

    // Return oldest first
    res.json({ messages: normalized.reverse() });

  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

/**
 * Create or get DM room between two users
 */
app.post('/api/rooms/dm', async (req, res) => {
  try {
    const { userId, otherUserId } = req.body;
    
    if (!userId || !otherUserId) {
      return res.status(400).json({ error: 'userId and otherUserId required' });
    }

    if (userId === otherUserId) {
      return res.status(400).json({ error: 'Cannot create DM with yourself' });
    }

    // Check if DM already exists
    const existing = await pool.query(`
      SELECT r.id
      FROM rooms r
      JOIN room_members rm1 ON r.id = rm1.room_id
      JOIN room_members rm2 ON r.id = rm2.room_id
      WHERE r.type = 'dm'
        AND ((rm1.user_id = $1 AND rm2.user_id = $2)
          OR (rm1.user_id = $2 AND rm2.user_id = $1))
      LIMIT 1
    `, [userId, otherUserId]);
    
    if (existing.rows.length > 0) {
      return res.json({ roomId: existing.rows[0].id, created: false });
    }
    
    // Create new DM room
    const roomId = crypto.randomUUID();
    
    await pool.query('BEGIN');
    
    try {
      // Create room
      await pool.query(
        'INSERT INTO rooms (id, type, created_by) VALUES ($1, $2, $3)',
        [roomId, 'dm', userId]
      );
      
      // Add both users as members
      await pool.query(
        'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)',
        [roomId, userId, otherUserId]
      );
      
      await pool.query('COMMIT');
      
      res.json({ roomId, created: true });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('Create DM error:', err);
    res.status(500).json({ error: 'Failed to create DM' });
  }
});

/**
 * Get user's contacts
 */
app.get('/api/contacts', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId parameter required' });
    }

    const result = await pool.query(`
      SELECT 
        u.id, u.email, u.name, u.status, u.last_seen,
        c.status as contact_status
      FROM users u
      JOIN contacts c ON (u.id = c.contact_id OR u.id = c.user_id)
      WHERE (c.user_id = $1 OR c.contact_id = $1)
        AND c.status = 'accepted'
        AND u.id != $1
      ORDER BY u.status DESC, u.last_seen DESC
    `, [userId]);
    
    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('Get contacts error:', err);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

//Join Room + Create Room options

app.post("/api/rooms/create", async (req, res) => {
  try {
    const { userId, name } = req.body;

    if (!userId || !name?.trim()) {
      return res.status(400).json({ error: "userId and name required" });
    }

    const roomId = crypto.randomUUID();

    await pool.query("BEGIN");

    try {
      await pool.query(
        "INSERT INTO rooms (id, name, type, created_by) VALUES ($1, $2, $3, $4)",
        [roomId, name.trim(), "group", userId]
      );

      await pool.query(
        "INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)",
        [roomId, userId]
      );

      await pool.query("COMMIT");

      res.json({ roomId });
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
  } catch (err) {
    console.error("Create room error:", err);
    res.status(500).json({ error: "Failed to create room" });
  }
});

app.post("/api/rooms/join", async (req, res) => {
  try {
    const { userId, roomId } = req.body;

    if (!userId || !roomId) {
      return res.status(400).json({ error: "userId and roomId required" });
    }

    const exists = await pool.query("SELECT id FROM rooms WHERE id = $1", [
      roomId,
    ]);

    if (exists.rows.length === 0) {
      return res.status(404).json({ error: "Room not found" });
    }

    await pool.query(
      `
      INSERT INTO room_members (room_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
      [roomId, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Join room error:", err);
    res.status(500).json({ error: "Failed to join room" });
  }
});


/**
 * Send contact request (auto-accept for simplicity)
 */
app.post('/api/contacts/request', async (req, res) => {
  try {
    const { userId, contactEmail } = req.body;
    
    if (!userId || !contactEmail) {
      return res.status(400).json({ error: 'userId and contactEmail required' });
    }

    // Find user by email
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [contactEmail]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const contactId = userResult.rows[0].id;

    if (userId === contactId) {
      return res.status(400).json({ error: 'Cannot add yourself as contact' });
    }
    
    // Check if already exists
    const existing = await pool.query(
      `SELECT * FROM contacts 
       WHERE (user_id = $1 AND contact_id = $2) 
          OR (user_id = $2 AND contact_id = $1)`,
      [userId, contactId]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Contact already exists' });
    }
    
    // Create contact
    await pool.query(
      'INSERT INTO contacts (user_id, contact_id, status) VALUES ($1, $2, $3)',
      [userId, contactId, 'pending']
    );
    
    res.json({ success: true, contactId });
  } catch (err) {
    console.error('Contact request error:', err);
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// Add these routes to your server/index.js file

/**
 * Get pending contact requests for a user
 */
app.get('/api/contacts/requests', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId parameter required' });
    }

    const result = await pool.query(`
      SELECT 
        c.id,
        c.user_id,
        c.contact_id,
        c.status,
        u.email,
        u.name
      FROM contacts c
      JOIN users u ON c.user_id = u.id
      WHERE c.contact_id = $1 AND c.status = 'pending'
      ORDER BY c.created_at DESC
    `, [userId]);
    
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('Get contact requests error:', err);
    res.status(500).json({ error: 'Failed to get contact requests' });
  }
});

/**
 * Accept contact request
 */
app.post('/api/contacts/accept', async (req, res) => {
  try {
    const { requestId, userId } = req.body;

    if (!requestId || !userId) {
      return res.status(400).json({ error: 'requestId and userId required' });
    }

    await pool.query("BEGIN");

    // Get request row, ensure it belongs to this user
    const request = await pool.query(
      `SELECT id, user_id, contact_id, status
       FROM contacts
       WHERE id = $1 AND contact_id = $2 AND status = 'pending'
       LIMIT 1`,
      [requestId, userId]
    );

    if (request.rows.length === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).json({ error: "Request not found" });
    }

    const fromUserId = request.rows[0].user_id;   // requester
    const toUserId = request.rows[0].contact_id;  // receiver (this user)

    // Accept the original request
    await pool.query(
      `UPDATE contacts SET status = 'accepted'
       WHERE id = $1`,
      [requestId]
    );

    // Create reverse row if it doesn't exist
    await pool.query(
      `INSERT INTO contacts (user_id, contact_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT DO NOTHING`,
      [toUserId, fromUserId]
    );

    await pool.query("COMMIT");

    res.json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error('Accept contact error:', err);
    res.status(500).json({ error: 'Failed to accept contact' });
  }
});


/**
 * Reject contact request
 */
app.post('/api/contacts/reject', async (req, res) => {
  try {
    const { requestId, userId } = req.body;
    
    if (!requestId || !userId) {
      return res.status(400).json({ error: 'requestId and userId required' });
    }

    await pool.query(
      'DELETE FROM contacts WHERE id = $1',
      [requestId]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error('Reject contact error:', err);
    res.status(500).json({ error: 'Failed to reject contact' });
  }
});

/**
 * Invite user to room
 */
app.post('/api/rooms/invite', async (req, res) => {
  try {
    const { roomId, userId, invitedBy } = req.body;
    
    if (!roomId || !userId || !invitedBy) {
      return res.status(400).json({ error: 'roomId, userId, and invitedBy required' });
    }

    // Check if room exists
    const roomCheck = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
    if (roomCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    // Check if user is already a member
    const memberCheck = await pool.query(
      'SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    
    if (memberCheck.rows.length > 0) {
      return res.status(409).json({ error: 'User is already a member' });
    }

    // Add user to room
    await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)',
      [roomId, userId]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error('Invite user error:', err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

/**
 * Update room name
 */
app.post('/api/rooms/update', async (req, res) => {
  try {
    const { roomId, name, userId } = req.body;
    
    if (!roomId || !name || !userId) {
      return res.status(400).json({ error: 'roomId, name, and userId required' });
    }

    // Check if user is a member of the room
    const memberCheck = await pool.query(
      'SELECT id FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'User is not a member of this room' });
    }

    // Update room name
    await pool.query(
      'UPDATE rooms SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [name.trim(), roomId]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error('Update room error:', err);
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// ====================================
// WEBSOCKET CONNECTION HANDLER
// ====================================

wss.on("connection", async (ws, req) => {
  ws.currentRoom = null;
  ws.userId = null;
  ws.userEmail = null;

  console.log("📱 Client connecting...");

  // Extract JWT token from query string
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    console.log("❌ No token provided");
    ws.close();
    return;
  }

  // Verify JWT with Appwrite
  try {
    const response = await fetch(`${APPWRITE_ENDPOINT}/account`, {
      headers: {
        "X-Appwrite-Project": APPWRITE_PROJECT_ID,
        "X-Appwrite-JWT": token,
      },
    });

    if (!response.ok) {
      console.log("❌ Invalid JWT");
      ws.close();
      return;
    }

    const user = await response.json();
    ws.userId = user.$id;
    ws.userEmail = user.email;

    console.log("✅ User authenticated:", ws.userEmail);

    // Upsert user in database
      await pool.query(
        `
        INSERT INTO users (id, email, name, status)
        VALUES ($1, $2, $3, 'online')
        ON CONFLICT (id)
        DO UPDATE SET
          email = EXCLUDED.email,
          name = COALESCE(EXCLUDED.name, users.name),
          status = 'online',
          last_seen = CURRENT_TIMESTAMP
      `,
        [ws.userId, ws.userEmail, user.name || null]
      );


    // Track online user
    if (!onlineUsers.has(ws.userId)) {
      onlineUsers.set(ws.userId, new Set());
    }
    onlineUsers.get(ws.userId).add(ws);

    // Broadcast user online status
    broadcast({
      type: "USER_STATUS",
      payload: { userId: ws.userId, status: "online" }
    });

  } catch (err) {
    console.error("❌ Auth failed:", err.message);
    ws.close();
    return;
  }

  // ====================================
  // MESSAGE HANDLERS
  // ====================================

  ws.on("message", async (data) => {
    let message;

    try {
      message = JSON.parse(data.toString());
    } catch {
      console.error("Invalid JSON message");
      return sendError(ws, "Invalid JSON message");
    }

    const { type, payload } = message;
    if (!type) return;

    console.log(`📨 ${type} from ${ws.userEmail}`);

    try {
      switch (type) {
        case "PING": {
          ws.send(JSON.stringify({
            type: "PONG",
            payload: {},
            meta: { timestamp: Date.now() },
          }));
          break;
        }

        case "JOIN_ROOM": {
          const { roomId } = payload;
          if (!roomId) return;

          // Leave previous room
          if (ws.currentRoom) {
            const oldRoom = rooms.get(ws.currentRoom);
            oldRoom?.delete(ws);
          }

          // Join new room
          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
          }

          rooms.get(roomId).add(ws);
          ws.currentRoom = roomId;

          // Update last_read_at
          await pool.query(
            `UPDATE room_members 
             SET last_read_at = CURRENT_TIMESTAMP 
             WHERE room_id = $1 AND user_id = $2`,
            [roomId, ws.userId]
          );

          ws.send(JSON.stringify({
            type: "JOINED_ROOM",
            payload: { roomId },
            meta: { timestamp: Date.now() },
          }));

          // Notify others
          broadcastToRoom(roomId, {
            type: "USER_JOINED",
            payload: { userId: ws.userId, roomId }
          }, ws);

          break;
        }

        case "LEAVE_ROOM": {
          if (ws.currentRoom) {
            broadcastToRoom(ws.currentRoom, {
              type: "USER_LEFT",
              payload: { userId: ws.userId, roomId: ws.currentRoom }
            }, ws);

            rooms.get(ws.currentRoom)?.delete(ws);
            ws.currentRoom = null;
          }
          break;
        }

        case "ROOM_MESSAGE": {
          const { message: content } = payload;
          if (!ws.currentRoom || !content || !content.trim()) return;

          const clients = rooms.get(ws.currentRoom);
          if (!clients) return;

          const messageId = crypto.randomUUID();
          const timestamp = new Date();

          const enrichedMessage = {
            id: messageId,
            roomId: ws.currentRoom,
            senderId: ws.userId,
            senderEmail: ws.userEmail,
            content: content.trim(),
            created_at: timestamp.toISOString(),
            timestamp: timestamp.getTime(),
          };

          // Persist to database
          try {
            await pool.query(
              `INSERT INTO messages (id, room_id, sender_id, content, created_at)
               VALUES ($1, $2, $3, $4, $5)`,
              [messageId, ws.currentRoom, ws.userId, content.trim(), timestamp]
            );

            // Update room timestamp
            await pool.query(
              'UPDATE rooms SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
              [ws.currentRoom]
            );

          } catch (err) {
            console.error('Failed to save message:', err);
          }

          // Broadcast to all in room
          broadcastToRoom(ws.currentRoom, {
            type: "ROOM_MESSAGE",
            payload: enrichedMessage,
            meta: { timestamp: Date.now() }
          });

          break;
        }

        case "TYPING_START": {
          if (!ws.currentRoom) return;
          
          broadcastToRoom(ws.currentRoom, {
            type: "USER_TYPING",
            payload: { 
              userId: ws.userId, 
              roomId: ws.currentRoom, 
              typing: true 
            }
          }, ws);

          break;
        }

        case "TYPING_STOP": {
          if (!ws.currentRoom) return;
          
          broadcastToRoom(ws.currentRoom, {
            type: "USER_TYPING",
            payload: { 
              userId: ws.userId, 
              roomId: ws.currentRoom, 
              typing: false 
            }
          }, ws);

          break;
        }

        case "MESSAGE_READ": {
          const { messageId } = payload;
          if (!messageId) return;

          try {
            await pool.query(
              `INSERT INTO message_receipts (message_id, user_id) 
               VALUES ($1, $2) 
               ON CONFLICT DO NOTHING`,
              [messageId, ws.userId]
            );
          } catch (err) {
            console.error('Failed to save read receipt:', err);
          }

          break;
        }

        default: {
          sendError(ws, "Unknown event type");
          break;
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
      sendError(ws, "Internal server error");
    }
  });

  ws.on("close", async () => {
    console.log(`👋 ${ws.userEmail} disconnected`);

    // Remove from online users
    if (ws.userId && onlineUsers.has(ws.userId)) {
      onlineUsers.get(ws.userId).delete(ws);
      
      if (onlineUsers.get(ws.userId).size === 0) {
        onlineUsers.delete(ws.userId);

        // Update user status to offline
        try {
          await pool.query(
            `UPDATE users 
             SET status = 'offline', last_seen = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [ws.userId]
          );

          // Broadcast offline status
          broadcast({
            type: "USER_STATUS",
            payload: { userId: ws.userId, status: "offline" }
          });
        } catch (err) {
          console.error('Failed to update user status:', err);
        }
      }
    }

    // Remove from room
    if (ws.currentRoom) {
      rooms.get(ws.currentRoom)?.delete(ws);
      
      broadcastToRoom(ws.currentRoom, {
        type: "USER_LEFT",
        payload: { userId: ws.userId, roomId: ws.currentRoom }
      });
    }
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error for ${ws.userEmail}:`, error);
  });
});

// ====================================
// HELPER FUNCTIONS
// ====================================

function broadcast(message) {
  const msgString = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msgString);
    }
  });
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  const clients = rooms.get(roomId);
  if (!clients) return;

  const msgString = JSON.stringify(message);
  
  clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msgString);
    }
  });
}

function sendError(ws, errorMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "ERROR",
      payload: { message: errorMessage },
      meta: { timestamp: Date.now() }
    }));
  }
}

// ====================================
// START SERVER
// ====================================

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🎉 ===================================');
  console.log('🚀 Chat Server is Running!');
  console.log('🎉 ===================================');
  console.log('');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔐 Appwrite: ${APPWRITE_ENDPOINT}`);
  console.log(`📦 Project: ${APPWRITE_PROJECT_ID}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log('');
  console.log('✅ Ready to accept connections!');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
