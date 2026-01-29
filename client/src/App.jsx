import { useEffect, useRef, useState } from "react";
import { account } from "./appwrite";
import { ID } from "appwrite";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3000";
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

function App() {
  const wsRef = useRef(null);

  // Auth state
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [authMode, setAuthMode] = useState("login");

  // UI state
  const [activeView, setActiveView] = useState("rooms");
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  
  // Chat state
  const [rooms, setRooms] = useState([]);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  
  // Contact state
  const [contacts, setContacts] = useState([]);
  const [searchEmail, setSearchEmail] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  
  // Typing indicators
  const [typingUsers, setTypingUsers] = useState(new Set());
  const typingTimeoutRef = useRef(null);
  
  // Online status
  const [onlineUsers, setOnlineUsers] = useState(new Set());

  // Group Rooms state
  const [createRoomName, setCreateRoomName] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");

  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // ====================================
  // AUTH FUNCTIONS
  // ====================================

  const signup = async () => {
    try {
      if (!name.trim()) {
        alert("Please enter your name");
        return;
      }

      await account.create(ID.unique(), email, password, name);

      if (typeof account.createEmailPasswordSession === "function") {
        await account.createEmailPasswordSession(email, password);
      } else if (typeof account.createSession === "function") {
        await account.createSession(email, password);
      } else if (typeof account.createEmailSession === "function") {
        await account.createEmailSession(email, password);
      } else {
        throw new Error("Appwrite SDK missing session creation method");
      }

      const user = await account.get();
      setUser(user);
    } catch (err) {
      alert("Signup failed: " + (err?.message || err));
      console.error(err);
    }
  };

  const login = async () => {
    try {
      if (typeof account.createEmailPasswordSession === "function") {
        await account.createEmailPasswordSession(email, password);
      } else if (typeof account.createSession === "function") {
        await account.createSession(email, password);
      } else if (typeof account.createEmailSession === "function") {
        await account.createEmailSession(email, password);
      } else {
        throw new Error("Appwrite SDK missing login method");
      }
  
      const user = await account.get();
      setUser(user);
    } catch (err) {
      alert("Login failed: " + (err?.message || err));
      console.error(err);
    }
  };

  const logout = async () => {
    try {
      await account.deleteSession("current");
      setUser(null);
      setRooms([]);
      setMessages([]);
      setContacts([]);
      setSelectedRoom(null);
      if (wsRef.current) wsRef.current.close();
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  useEffect(() => {
    account.get().then(setUser).catch(() => {});
  }, []);

  // ====================================
  // WEBSOCKET CONNECTION
  // ====================================

  const getJwt = async () => {
    const jwt = await account.createJWT();
    return jwt.jwt;
  };

  const handleSocketMessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "JOINED_ROOM":
        setSelectedRoom(msg.payload.roomId);
        break;

      case "ROOM_MESSAGE":
        setMessages((prev) => [...prev, msg.payload]);
        setRooms((prev) =>
          prev.map((r) =>
            r.id === msg.payload.roomId
              ? { ...r, last_message_at: new Date().toISOString() }
              : r
          )
        );
        break;

      case "USER_TYPING":{
        const { userId, typing } = msg.payload;
        setTypingUsers((prev) => {
          const newSet = new Set(prev);
          if (typing) {
            newSet.add(userId);
          } else {
            newSet.delete(userId);
          }
          return newSet;
        });
        break;
      }

      case "USER_STATUS":{
        const { userId: statusUserId, status } = msg.payload;
        setOnlineUsers((prev) => {
          const newSet = new Set(prev);
          if (status === "online") {
            newSet.add(statusUserId);
          } else {
            newSet.delete(statusUserId);
          }
          return newSet;
        });
        break;
      }
    }
  };

  useEffect(() => {
    if (!user) return;

    let ws;

    const initSocket = async () => {
      try {
        const token = await getJwt();
        ws = new WebSocket(`${WS_URL}?token=${token}`);
        wsRef.current = ws;

        ws.onopen = () => console.log("✅ WebSocket connected");
        ws.onmessage = handleSocketMessage;
        ws.onerror = (error) => console.error("WebSocket error:", error);
        ws.onclose = () => console.log("WebSocket closed");
      } catch (err) {
        console.error("❌ Failed to init WebSocket:", err);
      }
    };

    initSocket();

    return () => {
      if (ws) ws.close();
    };
  }, [user]);

  // ====================================
  // DATA FETCHING
  // ====================================

  const loadRooms = async () => {
    try {
      const res = await fetch(`${API_URL}/api/rooms?userId=${user.$id}`);
      const data = await res.json();
      setRooms(data.rooms || []);
    } catch (err) {
      console.error("Failed to load rooms:", err);
    }
  };

  const loadMessages = async (roomId) => {
    try {
      setIsLoadingMessages(true);
      const res = await fetch(`${API_URL}/api/messages/${roomId}?limit=50`);
      const data = await res.json();
      setMessages(data.messages || []);
    } catch (err) {
      console.error("Failed to load messages:", err);
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const loadContacts = async () => {
    try {
      const res = await fetch(`${API_URL}/api/contacts?userId=${user.$id}`);
      const data = await res.json();
      setContacts(data.contacts || []);
    } catch (err) {
      console.error("Failed to load contacts:", err);
    }
  };

  useEffect(() => {
    if (user) {
      loadRooms();
      loadContacts();
    }
  }, [user]);

  // ====================================
  // CHAT FUNCTIONS
  // ====================================

  const joinRoom = (roomId) => {
    if (!wsRef.current || !roomId) return;

    wsRef.current.send(
      JSON.stringify({
        type: "JOIN_ROOM",
        payload: { roomId },
        meta: { timestamp: Date.now() },
      })
    );

    setSelectedRoom(roomId);
    loadMessages(roomId);
  };

  const sendMessage = () => {
    if (!messageInput.trim() || !wsRef.current || !selectedRoom) return;

    wsRef.current.send(
      JSON.stringify({
        type: "ROOM_MESSAGE",
        payload: { message: messageInput },
        meta: { timestamp: Date.now() },
      })
    );

    setMessageInput("");
    stopTyping();
  };

  const startTyping = () => {
    if (!wsRef.current || !selectedRoom) return;

    wsRef.current.send(
      JSON.stringify({
        type: "TYPING_START",
        payload: {},
      })
    );

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(stopTyping, 3000);
  };

  const stopTyping = () => {
    if (!wsRef.current || !selectedRoom) return;

    wsRef.current.send(
      JSON.stringify({
        type: "TYPING_STOP",
        payload: {},
      })
    );

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  };

  // ====================================
  // CONTACT FUNCTIONS
  // ====================================

  const searchUsers = async () => {
    if (!searchEmail.trim()) return;

    try {
      const res = await fetch(
        `${API_URL}/api/users/search?email=${encodeURIComponent(searchEmail)}`
      );
      const data = await res.json();
      setSearchResults(data.users || []);
    } catch (err) {
      console.error("Search failed:", err);
    }
  };

  const addContact = async (contactEmail) => {
    try {
      const res = await fetch(`${API_URL}/api/contacts/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.$id, contactEmail }),
      });

      if (res.ok) {
        alert("Contact added!");
        loadContacts();
        setSearchEmail("");
        setSearchResults([]);
      } else {
        const data = await res.json();
        alert(data.error || "Failed to add contact");
      }
    } catch (err) {
      console.error("Add contact error:", err);
      alert("Failed to add contact");
    }
  };

  const startDirectMessage = async (contactId) => {
    try {
      const res = await fetch(`${API_URL}/api/rooms/dm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.$id, otherUserId: contactId }),
      });

      const data = await res.json();
      if (data.roomId) {
        setActiveView("rooms");
        loadRooms();
        setTimeout(() => joinRoom(data.roomId), 500);
      }
    } catch (err) {
      console.error("Start DM error:", err);
    }
  };

  const getRoomTitle = (room) => {
    if (!room) return "Chat";
    if (room.type === "dm") {
      return room.dm_name || room.dm_email || "Direct Message";
    }
    return room.name || `Room ${room.id.slice(0, 8)}`;
  };

  // ====================================
  // Group Room Functions
  // ====================================

  const createRoom = async () => {
    if (!createRoomName.trim()) return alert("Enter room name");

    const res = await fetch(`${API_URL}/api/rooms/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.$id, name: createRoomName }),
    });

    const data = await res.json();
    if (!res.ok) return alert(data.error || "Create room failed");

    setCreateRoomName("");
    setShowCreateRoom(false);
    await loadRooms();
    joinRoom(data.roomId);
  };

  const joinRoomById = async () => {
    if (!joinRoomId.trim()) return alert("Enter room ID");

    const res = await fetch(`${API_URL}/api/rooms/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.$id, roomId: joinRoomId }),
    });

    const data = await res.json();
    if (!res.ok) return alert(data.error || "Join room failed");

    setJoinRoomId("");
    await loadRooms();
    joinRoom(joinRoomId.trim());
  };

  const copyRoomId = async (roomId) => {
    try {
      await navigator.clipboard.writeText(roomId);
      alert("✅ Room ID copied!");
    } catch (err) {
      console.error("Copy failed:", err);
      alert("❌ Copy failed. Please copy manually.");
    }
  };

  // ====================================
  // RENDER: AUTH UI
  // ====================================

  if (!user) {
    return (
      <div style={styles.authContainer}>
        <div style={styles.authBox}>
          <div style={styles.authHeader}>
            <div style={styles.logoContainer}>
              <div style={styles.logo}>💬</div>
              <h1 style={styles.appTitle}>ChatFlow</h1>
            </div>
            <p style={styles.authSubtitle}>Connect with your team instantly</p>
          </div>

          <div style={styles.authToggle}>
            <button
              style={{
                ...styles.toggleBtn,
                ...(authMode === "login" ? styles.toggleBtnActive : {}),
              }}
              onClick={() => setAuthMode("login")}
            >
              Login
            </button>
            <button
              style={{
                ...styles.toggleBtn,
                ...(authMode === "signup" ? styles.toggleBtnActive : {}),
              }}
              onClick={() => setAuthMode("signup")}
            >
              Sign Up
            </button>
          </div>

          <div style={styles.authForm}>
            {authMode === "signup" && (
              <div style={styles.inputGroup}>
                <label style={styles.inputLabel}>Full Name</label>
                <input
                  style={styles.input}
                  placeholder="John Doe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Email</label>
              <input
                style={styles.input}
                placeholder="you@example.com"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Password</label>
              <input
                style={styles.input}
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button
              style={styles.authButton}
              onClick={authMode === "login" ? login : signup}
            >
              {authMode === "login" ? "Sign In" : "Create Account"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ====================================
  // RENDER: MAIN CHAT UI
  // ====================================

  const selectedRoomData = rooms.find((r) => r.id === selectedRoom);

  return (
    <div style={styles.container}>
      {/* SIDEBAR */}
      <div style={styles.sidebar}>
        {/* User Profile Header */}
        <div style={styles.userHeader}>
          <div style={styles.userProfile}>
            <div style={styles.avatar}>
              {user.name ? user.name.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()}
            </div>
            <div style={styles.userInfo}>
              <div style={styles.userName}>{user.name || user.email}</div>
              <div style={styles.userStatus}>
                <span style={styles.statusIndicator}></span>
                Online
              </div>
            </div>
          </div>
          <button style={styles.logoutBtn} onClick={logout} title="Logout">
            ⏻
          </button>
        </div>

        {/* Navigation Tabs */}
        <div style={styles.navTabs}>
          <button
            style={{
              ...styles.navTab,
              ...(activeView === "rooms" ? styles.navTabActive : {}),
            }}
            onClick={() => setActiveView("rooms")}
          >
            <span style={styles.navIcon}>💬</span>
            <span>Chats</span>
          </button>
          <button
            style={{
              ...styles.navTab,
              ...(activeView === "contacts" ? styles.navTabActive : {}),
            }}
            onClick={() => setActiveView("contacts")}
          >
            <span style={styles.navIcon}>👥</span>
            <span>Contacts</span>
          </button>
        </div>

        {/* ROOMS VIEW */}
        {activeView === "rooms" && (
          <div style={styles.listContainer}>
            <div style={styles.listHeader}>
              <h3 style={styles.listTitle}>Messages</h3>
              <button
                style={styles.iconBtn}
                onClick={() => setShowCreateRoom(!showCreateRoom)}
                title="Create Room"
              >
                ➕
              </button>
            </div>

            {showCreateRoom && (
              <div style={styles.createRoomPanel}>
                <div style={styles.panelSection}>
                  <label style={styles.panelLabel}>Create New Room</label>
                  <div style={styles.inputRow}>
                    <input
                      style={styles.panelInput}
                      placeholder="Room name"
                      value={createRoomName}
                      onChange={(e) => setCreateRoomName(e.target.value)}
                    />
                    <button style={styles.panelBtn} onClick={createRoom}>
                      Create
                    </button>
                  </div>
                </div>

                <div style={styles.panelSection}>
                  <label style={styles.panelLabel}>Join Existing Room</label>
                  <div style={styles.inputRow}>
                    <input
                      style={styles.panelInput}
                      placeholder="Room ID"
                      value={joinRoomId}
                      onChange={(e) => setJoinRoomId(e.target.value)}
                    />
                    <button style={styles.panelBtn} onClick={joinRoomById}>
                      Join
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div style={styles.roomsList}>
              {rooms.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={styles.emptyIcon}>📭</div>
                  <p style={styles.emptyText}>No chats yet</p>
                  <p style={styles.emptySubtext}>Start a conversation!</p>
                </div>
              ) : (
                rooms.map((room) => (
                  <div
                    key={room.id}
                    style={{
                      ...styles.roomItem,
                      ...(selectedRoom === room.id ? styles.roomItemActive : {}),
                    }}
                    onClick={() => joinRoom(room.id)}
                  >
                    <div style={styles.roomAvatar}>
                      {room.type === "dm" ? "👤" : "👥"}
                    </div>
                    <div style={styles.roomInfo}>
                      <div style={styles.roomHeader}>
                        <span style={styles.roomName}>{getRoomTitle(room)}</span>
                        {room.unread_count > 0 && (
                          <span style={styles.unreadBadge}>{room.unread_count}</span>
                        )}
                      </div>
                      <div style={styles.roomPreview}>
                        {room.last_message_at ? "Recent activity" : "No messages yet"}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* CONTACTS VIEW */}
        {activeView === "contacts" && (
          <div style={styles.listContainer}>
            <div style={styles.listHeader}>
              <h3 style={styles.listTitle}>Contacts</h3>
            </div>

            <div style={styles.searchSection}>
              <div style={styles.searchBox}>
                <input
                  style={styles.searchInput}
                  placeholder="Search by email..."
                  value={searchEmail}
                  onChange={(e) => setSearchEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && searchUsers()}
                />
                <button style={styles.searchBtn} onClick={searchUsers}>
                  🔍
                </button>
              </div>

              {searchResults.length > 0 && (
                <div style={styles.searchResults}>
                  {searchResults.map((result) => (
                    <div key={result.id} style={styles.searchResultItem}>
                      <div style={styles.searchResultInfo}>
                        <div style={styles.searchResultAvatar}>
                          {result.email.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div style={styles.searchResultName}>{result.email}</div>
                        </div>
                      </div>
                      <button
                        style={styles.addBtn}
                        onClick={() => addContact(result.email)}
                      >
                        + Add
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={styles.contactsList}>
              {contacts.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={styles.emptyIcon}>👥</div>
                  <p style={styles.emptyText}>No contacts yet</p>
                  <p style={styles.emptySubtext}>Search for users to add them</p>
                </div>
              ) : (
                contacts.map((contact) => (
                  <div key={contact.id} style={styles.contactItem}>
                    <div style={styles.contactAvatar}>
                      {contact.email.charAt(0).toUpperCase()}
                    </div>
                    <div style={styles.contactInfo}>
                      <div style={styles.contactName}>{contact.email}</div>
                      <div style={styles.contactStatus}>
                        <span
                          style={{
                            ...styles.statusDot,
                            background: onlineUsers.has(contact.id) ? "#10b981" : "#94a3b8",
                          }}
                        ></span>
                        {onlineUsers.has(contact.id) ? "Online" : "Offline"}
                      </div>
                    </div>
                    <button
                      style={styles.messageBtn}
                      onClick={() => startDirectMessage(contact.id)}
                    >
                      💬
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* CHAT AREA */}
      <div style={styles.chatArea}>
        {!selectedRoom ? (
          <div style={styles.welcomeScreen}>
            <div style={styles.welcomeIcon}>💬</div>
            <h2 style={styles.welcomeTitle}>Welcome to ChatFlow</h2>
            <p style={styles.welcomeText}>
              Select a conversation to start messaging
            </p>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div style={styles.chatHeader}>
              <div style={styles.chatHeaderLeft}>
                <div style={styles.chatAvatar}>
                  {selectedRoomData?.type === "dm" ? "👤" : "👥"}
                </div>
                <div>
                  <div style={styles.chatTitle}>
                    {getRoomTitle(selectedRoomData)}
                  </div>
                  {selectedRoomData?.type === "group" && (
                    <div style={styles.roomIdBadge}>
                      ID: {selectedRoom.slice(0, 8)}...
                    </div>
                  )}
                  {typingUsers.size > 0 && (
                    <div style={styles.typingIndicator}>
                      <span style={styles.typingDots}></span>
                      typing...
                    </div>
                  )}
                </div>
              </div>

              {selectedRoomData?.type === "group" && (
                <button
                  style={styles.copyBtn}
                  onClick={() => copyRoomId(selectedRoom)}
                  title="Copy Room ID"
                >
                  📋
                </button>
              )}
            </div>

            {/* Messages */}
            <div style={styles.messagesArea}>
              {isLoadingMessages ? (
                <div style={styles.loadingContainer}>
                  <div style={styles.spinner}></div>
                  <p style={styles.loadingText}>Loading messages...</p>
                </div>
              ) : messages.length === 0 ? (
                <div style={styles.emptyChat}>
                  <div style={styles.emptyChatIcon}>💭</div>
                  <p style={styles.emptyChatText}>No messages yet</p>
                  <p style={styles.emptyChatSubtext}>Start the conversation!</p>
                </div>
              ) : (
                <>
                  {messages.map((msg) => {
                    const isOwn = msg.senderId === user.$id;
                    return (
                      <div
                        key={msg.id}
                        style={{
                          ...styles.messageWrapper,
                          justifyContent: isOwn ? "flex-end" : "flex-start",
                        }}
                      >
                        {!isOwn && (
                          <div style={styles.messageAvatar}>
                            {(msg.senderName || msg.senderEmail || "U").charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div
                          style={{
                            ...styles.message,
                            ...(isOwn ? styles.messageOwn : styles.messageOther),
                          }}
                        >
                          {!isOwn && (
                            <div style={styles.messageSender}>
                              {msg.senderName || msg.senderEmail || msg.senderId?.slice(0, 8)}
                            </div>
                          )}
                          <div style={styles.messageContent}>{msg.content}</div>
                          <div style={styles.messageTime}>
                            {new Date(msg.timestamp || msg.created_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>
                        {isOwn && (
                          <div style={{...styles.messageAvatar, ...styles.messageAvatarOwn}}>
                            {user.name ? user.name.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            {/* Message Input */}
            <div style={styles.inputArea}>
              <input
                style={styles.messageInput}
                placeholder="Type a message..."
                value={messageInput}
                onChange={(e) => {
                  setMessageInput(e.target.value);
                  startTyping();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />
              <button
                style={styles.sendBtn}
                onClick={sendMessage}
                disabled={!messageInput.trim()}
              >
                <span style={styles.sendIcon}>➤</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ====================================
// MODERN STYLES
// ====================================

const styles = {
  // Auth Styles
  authContainer: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    padding: "20px",
  },
  authBox: {
    background: "white",
    borderRadius: "24px",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
    width: "100%",
    maxWidth: "440px",
    overflow: "hidden",
  },
  authHeader: {
    padding: "40px 40px 30px",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    textAlign: "center",
  },
  logoContainer: {
    marginBottom: "12px",
  },
  logo: {
    fontSize: "48px",
    marginBottom: "8px",
  },
  appTitle: {
    margin: "0",
    fontSize: "28px",
    fontWeight: "700",
    letterSpacing: "-0.5px",
  },
  authSubtitle: {
    margin: "0",
    fontSize: "14px",
    opacity: "0.9",
  },
  authToggle: {
    display: "flex",
    padding: "8px",
    margin: "20px 20px 0",
    background: "#f1f5f9",
    borderRadius: "12px",
  },
  toggleBtn: {
    flex: 1,
    padding: "10px",
    background: "transparent",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    color: "#64748b",
    cursor: "pointer",
    transition: "all 0.2s",
  },
  toggleBtnActive: {
    background: "white",
    color: "#667eea",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.1)",
  },
  authForm: {
    padding: "30px 40px 40px",
  },
  inputGroup: {
    marginBottom: "20px",
  },
  inputLabel: {
    display: "block",
    marginBottom: "8px",
    fontSize: "13px",
    fontWeight: "600",
    color: "#334155",
  },
  input: {
    width: "100%",
    padding: "12px 16px",
    border: "2px solid #e2e8f0",
    borderRadius: "12px",
    fontSize: "14px",
    transition: "all 0.2s",
    boxSizing: "border-box",
    outline: "none",
  },
  authButton: {
    width: "100%",
    padding: "14px",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    border: "none",
    borderRadius: "12px",
    fontSize: "15px",
    fontWeight: "600",
    cursor: "pointer",
    transition: "transform 0.2s, box-shadow 0.2s",
    marginTop: "10px",
  },

  // Main Layout
  container: {
    display: "flex",
    height: "100vh",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "#f8fafc",
  },
  sidebar: {
    width: "340px",
    background: "white",
    borderRight: "1px solid #e2e8f0",
    display: "flex",
    flexDirection: "column",
  },
  chatArea: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    background: "#f8fafc",
  },

  // Sidebar Components
  userHeader: {
    padding: "20px",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  userProfile: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  avatar: {
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "18px",
    fontWeight: "600",
    backdropFilter: "blur(10px)",
  },
  userInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  userName: {
    fontSize: "15px",
    fontWeight: "600",
  },
  userStatus: {
    fontSize: "12px",
    opacity: "0.9",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  statusIndicator: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#10b981",
    boxShadow: "0 0 8px rgba(16, 185, 129, 0.6)",
  },
  logoutBtn: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.2)",
    border: "none",
    color: "white",
    fontSize: "18px",
    cursor: "pointer",
    transition: "all 0.2s",
    backdropFilter: "blur(10px)",
  },

  navTabs: {
    display: "flex",
    padding: "12px 12px 0",
    gap: "8px",
    background: "white",
  },
  navTab: {
    flex: 1,
    padding: "12px",
    background: "transparent",
    border: "none",
    borderRadius: "12px 12px 0 0",
    fontSize: "14px",
    fontWeight: "600",
    color: "#64748b",
    cursor: "pointer",
    transition: "all 0.2s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
  },
  navTabActive: {
    background: "#f8fafc",
    color: "#667eea",
  },
  navIcon: {
    fontSize: "18px",
  },

  listContainer: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#f8fafc",
  },
  listHeader: {
    padding: "16px 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "white",
    borderBottom: "1px solid #e2e8f0",
  },
  listTitle: {
    margin: 0,
    fontSize: "16px",
    fontWeight: "600",
    color: "#1e293b",
  },
  iconBtn: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    background: "#f1f5f9",
    border: "none",
    fontSize: "16px",
    cursor: "pointer",
    transition: "all 0.2s",
  },

  createRoomPanel: {
    padding: "16px",
    background: "white",
    borderBottom: "1px solid #e2e8f0",
  },
  panelSection: {
    marginBottom: "12px",
  },
  panelLabel: {
    display: "block",
    marginBottom: "8px",
    fontSize: "12px",
    fontWeight: "600",
    color: "#64748b",
  },
  inputRow: {
    display: "flex",
    gap: "8px",
  },
  panelInput: {
    flex: 1,
    padding: "10px 12px",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    fontSize: "13px",
  },
  panelBtn: {
    padding: "10px 16px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  roomsList: {
    flex: 1,
    overflowY: "auto",
    padding: "8px",
  },
  roomItem: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px",
    marginBottom: "4px",
    borderRadius: "12px",
    cursor: "pointer",
    transition: "all 0.2s",
    background: "white",
  },
  roomItemActive: {
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
  },
  roomAvatar: {
    width: "40px",
    height: "40px",
    borderRadius: "12px",
    background: "#f1f5f9",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "20px",
  },
  roomInfo: {
    flex: 1,
    minWidth: 0,
  },
  roomHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "4px",
  },
  roomName: {
    fontSize: "14px",
    fontWeight: "600",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  unreadBadge: {
    padding: "2px 8px",
    background: "#ef4444",
    color: "white",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: "700",
  },
  roomPreview: {
    fontSize: "12px",
    opacity: "0.7",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  emptyState: {
    padding: "60px 20px",
    textAlign: "center",
  },
  emptyIcon: {
    fontSize: "48px",
    marginBottom: "12px",
  },
  emptyText: {
    margin: "0 0 4px",
    fontSize: "16px",
    fontWeight: "600",
    color: "#1e293b",
  },
  emptySubtext: {
    margin: "0",
    fontSize: "13px",
    color: "#94a3b8",
  },

  // Contacts Section
  searchSection: {
    padding: "16px",
    background: "white",
    borderBottom: "1px solid #e2e8f0",
  },
  searchBox: {
    display: "flex",
    gap: "8px",
  },
  searchInput: {
    flex: 1,
    padding: "10px 14px",
    border: "2px solid #e2e8f0",
    borderRadius: "12px",
    fontSize: "13px",
    outline: "none",
  },
  searchBtn: {
    padding: "10px 16px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "12px",
    fontSize: "16px",
    cursor: "pointer",
  },
  searchResults: {
    marginTop: "12px",
    padding: "8px",
    background: "#f8fafc",
    borderRadius: "12px",
  },
  searchResultItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px",
    marginBottom: "4px",
    background: "white",
    borderRadius: "8px",
  },
  searchResultInfo: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  searchResultAvatar: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    background: "#f1f5f9",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    fontWeight: "600",
    color: "#667eea",
  },
  searchResultName: {
    fontSize: "13px",
    fontWeight: "500",
  },
  addBtn: {
    padding: "6px 12px",
    background: "#10b981",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "12px",
    fontWeight: "600",
    cursor: "pointer",
  },

  contactsList: {
    flex: 1,
    overflowY: "auto",
    padding: "8px",
  },
  contactItem: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px",
    marginBottom: "4px",
    background: "white",
    borderRadius: "12px",
  },
  contactAvatar: {
    width: "40px",
    height: "40px",
    borderRadius: "12px",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "16px",
    fontWeight: "600",
  },
  contactInfo: {
    flex: 1,
  },
  contactName: {
    fontSize: "14px",
    fontWeight: "600",
    marginBottom: "4px",
    color: "#1e293b",
  },
  contactStatus: {
    fontSize: "12px",
    color: "#64748b",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  statusDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
  },
  messageBtn: {
    width: "36px",
    height: "36px",
    borderRadius: "8px",
    background: "#f1f5f9",
    border: "none",
    fontSize: "18px",
    cursor: "pointer",
    transition: "all 0.2s",
  },

  // Chat Area
  welcomeScreen: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px",
  },
  welcomeIcon: {
    fontSize: "80px",
    marginBottom: "24px",
    opacity: "0.5",
  },
  welcomeTitle: {
    margin: "0 0 12px",
    fontSize: "28px",
    fontWeight: "700",
    color: "#1e293b",
  },
  welcomeText: {
    margin: "0",
    fontSize: "16px",
    color: "#64748b",
  },

  chatHeader: {
    padding: "20px 24px",
    background: "white",
    borderBottom: "1px solid #e2e8f0",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  chatHeaderLeft: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  chatAvatar: {
    width: "40px",
    height: "40px",
    borderRadius: "12px",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "20px",
  },
  chatTitle: {
    fontSize: "16px",
    fontWeight: "600",
    color: "#1e293b",
    marginBottom: "2px",
  },
  roomIdBadge: {
    display: "inline-block",
    padding: "2px 8px",
    background: "#f1f5f9",
    borderRadius: "6px",
    fontSize: "11px",
    color: "#64748b",
    marginBottom: "2px",
  },
  typingIndicator: {
    fontSize: "12px",
    color: "#64748b",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  typingDots: {
    display: "inline-block",
    width: "4px",
    height: "4px",
    borderRadius: "50%",
    background: "#64748b",
    animation: "typing 1.4s infinite",
  },
  copyBtn: {
    padding: "8px 12px",
    background: "#f1f5f9",
    border: "none",
    borderRadius: "8px",
    fontSize: "16px",
    cursor: "pointer",
    transition: "all 0.2s",
  },

  messagesArea: {
    flex: 1,
    overflowY: "auto",
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  loadingContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: "16px",
  },
  spinner: {
    width: "40px",
    height: "40px",
    border: "4px solid #e2e8f0",
    borderTop: "4px solid #667eea",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  loadingText: {
    color: "#64748b",
    fontSize: "14px",
  },
  emptyChat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
  },
  emptyChatIcon: {
    fontSize: "64px",
    marginBottom: "16px",
    opacity: "0.3",
  },
  emptyChatText: {
    margin: "0 0 4px",
    fontSize: "18px",
    fontWeight: "600",
    color: "#1e293b",
  },
  emptyChatSubtext: {
    margin: "0",
    fontSize: "14px",
    color: "#94a3b8",
  },

  messageWrapper: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-end",
  },
  messageAvatar: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    background: "#f1f5f9",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    fontWeight: "600",
    color: "#667eea",
    flexShrink: 0,
  },
  messageAvatarOwn: {
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
  },
  message: {
    maxWidth: "60%",
    padding: "12px 16px",
    borderRadius: "16px",
    fontSize: "14px",
    lineHeight: "1.5",
  },
  messageOwn: {
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    borderBottomRightRadius: "4px",
  },
  messageOther: {
    background: "white",
    color: "#1e293b",
    borderBottomLeftRadius: "4px",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
  },
  messageSender: {
    fontSize: "11px",
    fontWeight: "600",
    marginBottom: "4px",
    opacity: "0.8",
  },
  messageContent: {
    marginBottom: "4px",
    wordWrap: "break-word",
  },
  messageTime: {
    fontSize: "10px",
    opacity: "0.6",
    textAlign: "right",
  },

  inputArea: {
    padding: "20px 24px",
    background: "white",
    borderTop: "1px solid #e2e8f0",
    display: "flex",
    gap: "12px",
    alignItems: "center",
  },
  messageInput: {
    flex: 1,
    padding: "14px 18px",
    border: "2px solid #e2e8f0",
    borderRadius: "24px",
    fontSize: "14px",
    outline: "none",
    transition: "all 0.2s",
  },
  sendBtn: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    border: "none",
    cursor: "pointer",
    transition: "all 0.2s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  sendIcon: {
    fontSize: "18px",
  },
};

// Add keyframes animation for spinner
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  @keyframes typing {
    0%, 60%, 100% { opacity: 1; }
    30% { opacity: 0.3; }
  }
`;
document.head.appendChild(styleSheet);

export default App;
