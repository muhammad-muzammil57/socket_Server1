import express from "express"
import http from "http"
import dotenv from "dotenv"
import { Server } from "socket.io"

dotenv.config()

const app = express()
app.use(express.json())
const server = http.createServer(app)
const port = process.env.PORT || 5000

// ─── STARTUP CHECKS ───────────────────────────────────────────────────────
// Yeh checks isliye add ki hain taa k agar env vars missing hon to turant
// pata chal jaye (logs mein), na k har request silently 401/CORS-fail ho.
if (!process.env.SOCKET_INTERNAL_SECRET) {
  console.warn(
    "⚠️  WARNING: SOCKET_INTERNAL_SECRET is NOT set. /emit endpoint will reject ALL requests (401). " +
    "Order chat, order status/location updates, and delivery broadcasts will NOT work in real-time until this is set."
  )
}
if (!process.env.NEXT_BASE_URL) {
  console.warn(
    "⚠️  WARNING: NEXT_BASE_URL is NOT set. Browser socket connections from your frontend will be blocked by CORS."
  )
}

// ─── CORS: multiple origins support ──────────────────────────────────────
// NEXT_BASE_URL comma-separated list ho sakta hai, e.g.
// "https://ishymartgrocery.vercel.app,http://localhost:3000"
// taa k production + local dev dono se connect ho sake.
const allowedOrigins = (process.env.NEXT_BASE_URL || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
    methods: ["GET", "POST"],
  },
})

// Active chat rooms track karo
// roomId => { userId, userName, adminId, adminName, adminSocketId }
const chatRooms = new Map()

// ─── INTERNAL EMIT ENDPOINT ───────────────────────────────────────────────
// Next.js API routes ek alag process/server hain, is liye woh seedha io.emit
// nahi kar sakte. Jab bhi order/delivery se related koi cheez DB mein save
// hoti hai, Next.js yeh internal endpoint call karta hai (server-to-server,
// shared secret ke sath) taa k connected clients ko turant (real-time)
// update mil jaye — koi 3/4/5 second wala polling ab nahi chahiye.
app.post("/emit", (req, res) => {
  const secret = req.headers["x-internal-secret"]
  if (!process.env.SOCKET_INTERNAL_SECRET || secret !== process.env.SOCKET_INTERNAL_SECRET) {
    return res.status(401).json({ message: "Unauthorized" })
  }

  const { room, event, payload } = req.body || {}
  if (!room || !event) {
    return res.status(400).json({ message: "room and event are required" })
  }

  io.to(room).emit(event, payload ?? {})
  return res.json({ ok: true })
})

app.get("/health", (req, res) => res.json({ ok: true }))

// Root route — sirf isliye taa k koi bhi browser mein URL kholay to
// "Cannot GET /" ki jagah ek meaningful response mile (health-check tools
// aur Render/Railway jaise hosts is route ko bhi ping kar sakte hain).
app.get("/", (req, res) => res.json({ ok: true, service: "ishymart-socket-server" }))

io.on("connection", (socket) => {
  console.log("User Connected:", socket.id)

  socket.on("identity", (userId) => {
    console.log("User Id:", userId)
  })

  // ─── ORDER TRACKING (real-time) ──────────────────────────────────────
  // Buyer apna order track karte waqt is room mein join hota hai, delivery
  // boy bhi apni active delivery ke doraan isi room mein hota hai. Location
  // aur status updates isi room ko broadcast hoti hain — koi polling nahi.
  socket.on("order:join", ({ orderId }) => {
    if (!orderId) return
    socket.join(`order:${orderId}`)
  })

  socket.on("order:leave", ({ orderId }) => {
    if (!orderId) return
    socket.leave(`order:${orderId}`)
  })

  // ─── DELIVERY BOY ONLINE POOL ─────────────────────────────────────────
  // Jab delivery boy "Online" toggle karta hai, woh is shared room mein aa
  // jata hai. Naye order broadcasts, aur "kisi aur ne accept kar liya" jaisi
  // updates isi room ko bheji jati hain — sab online delivery boys ko real
  // time mein milti hain, refresh ki zaroorat nahi.
  socket.on("deliveryBoy:online", ({ deliveryBoyId }) => {
    socket.join("onlineDeliveryBoys")
    if (deliveryBoyId) socket.join(`deliveryBoy:${deliveryBoyId}`)
  })

  socket.on("deliveryBoy:offline", () => {
    socket.leave("onlineDeliveryBoys")
  })

  // ─── ADMIN ORDERS ROOM ─────────────────────────────────────────────
  // Admin ka "Manage Orders" page is room mein join hota hai — jab bhi
  // koi order status change ho, ya assign/deliver ho, isi room ko bataya
  // jata hai taa k page khud ko real-time refresh kar sake.
  socket.on("admin:join", () => {
    socket.join("adminOrders")
  })

  // ─── User live chat shuru karta hai ──────────────────
  socket.on("chat:start", ({ roomId, userId, userName }) => {
    socket.join(roomId)
    chatRooms.set(roomId, {
      userId,
      userName,
      userSocketId: socket.id,
      adminId: null,
      adminName: null,
      adminSocketId: null,
    })
    console.log(`Chat started — Room: ${roomId} — User: ${userName}`)
  })

  // ─── Admin chat join karta hai ────────────────────────
  socket.on("chat:join", ({ roomId, adminId, adminName }) => {
    const room = chatRooms.get(roomId)
    if (!room) {
      socket.emit("chat:error", { message: "Room nahi mila" })
      return
    }
    if (room.adminId) {
      socket.emit("chat:already-taken", {
        message: "Koi aur admin pehle se join kar chuka hai",
      })
      return
    }
    socket.join(roomId)
    room.adminId = adminId
    room.adminName = adminName
    room.adminSocketId = socket.id
    chatRooms.set(roomId, room)
    socket.to(roomId).emit("chat:admin-joined", { adminName })
    console.log(`Admin joined — Room: ${roomId} — Admin: ${adminName}`)
  })

  // ─── Message bhejnа ──────────────────────────────────
  socket.on("chat:message", ({ roomId, sender, senderName, text }) => {
    const message = {
      sender,
      senderName,
      text,
      createdAt: new Date(),
    }
    socket.to(roomId).emit("chat:message", message)
    console.log(`Message in ${roomId} from ${senderName}: ${text}`)
  })

  // ─── FIX 1: Typing relay — YAHAN SE ADD KIYA ─────────
  // Pehle yeh event bilkul nahi tha — isliye typing dots kaam nahi karte the
  socket.on("chat:typing", ({ roomId, isTyping, senderName }) => {
    socket.to(roomId).emit("chat:typing", { isTyping, senderName })
  })

  // ─── File message relay ───────────────────────────────
  socket.on("chat:file", ({ roomId, sender, senderName, fileName, fileUrl, fileType }) => {
    const message = {
      sender,
      senderName,
      fileName,
      fileUrl,
      fileType,
      type: "file",
      createdAt: new Date(),
    }
    socket.to(roomId).emit("chat:file", message)
    console.log(`File in ${roomId} from ${senderName}: ${fileName}`)
  })

  // ─── Chat band karo ──────────────────────────────────
  socket.on("chat:close", ({ roomId }) => {
    socket.to(roomId).emit("chat:closed")
    chatRooms.delete(roomId)
    socket.leave(roomId)
    console.log(`Chat closed — Room: ${roomId}`)
  })

  // ─── Disconnect ──────────────────────────────────────
  socket.on("disconnect", () => {
    chatRooms.forEach((room, roomId) => {
      if (room.userSocketId === socket.id) {
        socket.to(roomId).emit("chat:user-left")
        chatRooms.delete(roomId)
      } else if (room.adminSocketId === socket.id) {
        socket.to(roomId).emit("chat:admin-left")
        room.adminId = null
        room.adminName = null
        room.adminSocketId = null
        chatRooms.set(roomId, room)
      }
    })
    console.log("User Disconnected:", socket.id)
  })
})

server.listen(port, () => {
  console.log("Server Started At", port)
})
