import { useEffect, useRef, useState } from "react";
import { account } from "./appwrite";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:3000";
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

function App() {
  const wsRef = useRef(null);

  // Auth state
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // UI state
  const [activeView, setActiveView] = useState("rooms"); // rooms, contacts, settings
  const [selectedRoom, setSelectedRoom] = useState(null);
  
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

  // ====================================
  // AUTH FUNCTIONS
  // ====================================

  const signup = async () => {
    try {
      await account.create("unique()", email, password);
      await login();
    } catch (err) {
      alert("Signup failed: " + err.message);
    }
  };

  const login = async () => {
    try {
      await account.createEmailPasswordSession(email, password);
      const user = await account.get();
      setUser(user);
    } catch (err) {
      alert("Login failed: " + err.message);
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

  // Auto-login on refresh
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
    console.log("WS message:", msg);

    switch (msg.type) {
      case "JOINED_ROOM":
        setSelectedRoom(msg.payload.roomId);
        break;

      case "ROOM_MESSAGE":
        setMessages((prev) => [...prev, msg.payload]);
        // Update room's last message
        setRooms((prev) =>
          prev.map((r) =>
            r.id === msg.payload.roomId
              ? { ...r, last_message_at: new Date().toISOString() }
              : r
          )
        );
        break;

      case "USER_TYPING":
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

      case "USER_STATUS":
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

      case "USER_JOINED":
      case "USER_LEFT":
        // Optionally show notifications
        break;
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

    // Auto-stop typing after 3 seconds
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
        loadRooms(); // Refresh rooms list
        setTimeout(() => joinRoom(data.roomId), 500);
      }
    } catch (err) {
      console.error("Start DM error:", err);
    }
  };

  // ====================================
  // RENDER: AUTH UI
  // ====================================

  if (!user) {
    return (
      <div style={styles.authContainer}>
        <div style={styles.authBox}>
          <h2 style={styles.authTitle}>Real-Time Chat</h2>
          <input
            style={styles.input}
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div style={styles.authButtons}>
            <button style={styles.button} onClick={login}>
              Login
            </button>
            <button style={styles.buttonSecondary} onClick={signup}>
              Signup
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
        {/* User Header */}
        <div style={styles.userHeader}>
          <div>
            <div style={styles.userName}>{user.email}</div>
            <div style={styles.userStatus}>
              <span style={styles.statusDot}></span> Online
            </div>
          </div>
          <button style={styles.logoutButton} onClick={logout}>
            Logout
          </button>
        </div>

        {/* Navigation Tabs */}
        <div style={styles.tabs}>
          <button
            style={{
              ...styles.tab,
              ...(activeView === "rooms" ? styles.tabActive : {}),
            }}
            onClick={() => setActiveView("rooms")}
          >
            💬 Chats
          </button>
          <button
            style={{
              ...styles.tab,
              ...(activeView === "contacts" ? styles.tabActive : {}),
            }}
            onClick={() => setActiveView("contacts")}
          >
            👥 Contacts
          </button>
        </div>

        {/* ROOMS VIEW */}
        {activeView === "rooms" && (
          <div style={styles.list}>
            <div style={styles.listHeader}>
              <h3>Your Chats</h3>
              <button
                style={styles.refreshButton}
                onClick={loadRooms}
                title="Refresh"
              >
                🔄
              </button>
            </div>
            {rooms.length === 0 ? (
              <div style={styles.emptyState}>
                No chats yet. Add a contact to start chatting!
              </div>
            ) : (
              rooms.map((room) => (
                <div
                  key={room.id}
                  style={{
                    ...styles.listItem,
                    ...(selectedRoom === room.id ? styles.listItemActive : {}),
                  }}
                  onClick={() => joinRoom(room.id)}
                >
                  <div style={styles.listItemContent}>
                    <div style={styles.listItemTitle}>
                      {room.name || `Room ${room.id.slice(0, 8)}`}
                      {room.type === "dm" && " (DM)"}
                    </div>
                    {room.unread_count > 0 && (
                      <span style={styles.badge}>{room.unread_count}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* CONTACTS VIEW */}
        {activeView === "contacts" && (
          <div style={styles.list}>
            <div style={styles.listHeader}>
              <h3>Contacts</h3>
            </div>

            {/* Search Users */}
            <div style={styles.searchBox}>
              <input
                style={styles.searchInput}
                placeholder="Search by email..."
                value={searchEmail}
                onChange={(e) => setSearchEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchUsers()}
              />
              <button style={styles.searchButton} onClick={searchUsers}>
                🔍
              </button>
            </div>

            {/* Search Results */}
            {searchResults.length > 0 && (
              <div style={styles.searchResults}>
                <div style={styles.searchResultsTitle}>Search Results:</div>
                {searchResults.map((result) => (
                  <div key={result.id} style={styles.searchResultItem}>
                    <div>{result.email}</div>
                    <button
                      style={styles.addButton}
                      onClick={() => addContact(result.email)}
                    >
                      + Add
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Contacts List */}
            {contacts.length === 0 ? (
              <div style={styles.emptyState}>
                No contacts yet. Search for users by email to add them!
              </div>
            ) : (
              contacts.map((contact) => (
                <div key={contact.id} style={styles.contactItem}>
                  <div>
                    <div style={styles.contactName}>{contact.email}</div>
                    <div style={styles.contactStatus}>
                      <span
                        style={{
                          ...styles.statusDot,
                          ...(onlineUsers.has(contact.id)
                            ? styles.statusDotOnline
                            : styles.statusDotOffline),
                        }}
                      ></span>
                      {onlineUsers.has(contact.id) ? "Online" : "Offline"}
                    </div>
                  </div>
                  <button
                    style={styles.dmButton}
                    onClick={() => startDirectMessage(contact.id)}
                  >
                    💬 Message
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* CHAT AREA */}
      <div style={styles.chatArea}>
        {!selectedRoom ? (
          <div style={styles.emptyChatState}>
            <div style={styles.emptyChatIcon}>💬</div>
            <div style={styles.emptyChatText}>
              Select a chat to start messaging
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div style={styles.chatHeader}>
              <div>
                <div style={styles.chatTitle}>
                  {selectedRoomData?.name || `Room ${selectedRoom.slice(0, 8)}`}
                </div>
                {typingUsers.size > 0 && (
                  <div style={styles.typingIndicator}>
                    {typingUsers.size === 1 ? "Someone is" : `${typingUsers.size} people are`}{" "}
                    typing...
                  </div>
                )}
              </div>
            </div>

            {/* Messages */}
            <div style={styles.messagesContainer}>
              {isLoadingMessages ? (
                <div style={styles.loading}>Loading messages...</div>
              ) : messages.length === 0 ? (
                <div style={styles.noMessages}>
                  No messages yet. Start the conversation!
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    style={{
                      ...styles.message,
                      ...(msg.senderId === user.$id
                        ? styles.messageOwn
                        : styles.messageOther),
                    }}
                  >
                    {msg.senderId !== user.$id && (
                      <div style={styles.messageSender}>
                        {msg.senderEmail || msg.senderId?.slice(0, 8)}
                      </div>
                    )}
                    <div style={styles.messageContent}>{msg.content}</div>
                    <div style={styles.messageTime}>
                      {new Date(msg.timestamp || msg.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Message Input */}
            <div style={styles.inputContainer}>
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
              <button style={styles.sendButton} onClick={sendMessage}>
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ====================================
// STYLES
// ====================================

const styles = {
  // Auth styles
  authContainer: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    height: "100vh",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  },
  authBox: {
    background: "white",
    padding: "40px",
    borderRadius: "12px",
    boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
    width: "100%",
    maxWidth: "400px",
  },
  authTitle: {
    marginBottom: "30px",
    textAlign: "center",
    color: "#333",
  },
  input: {
    width: "100%",
    padding: "12px",
    marginBottom: "15px",
    border: "1px solid #ddd",
    borderRadius: "6px",
    fontSize: "14px",
    boxSizing: "border-box",
  },
  authButtons: {
    display: "flex",
    gap: "10px",
  },
  button: {
    flex: 1,
    padding: "12px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "600",
  },
  buttonSecondary: {
    flex: 1,
    padding: "12px",
    background: "#f0f0f0",
    color: "#333",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "600",
  },

  // Main layout
  container: {
    display: "flex",
    height: "100vh",
    fontFamily: "Arial, sans-serif",
  },
  sidebar: {
    width: "300px",
    borderRight: "1px solid #e0e0e0",
    display: "flex",
    flexDirection: "column",
    background: "#f8f9fa",
  },
  chatArea: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    background: "#fff",
  },

  // Sidebar components
  userHeader: {
    padding: "20px",
    borderBottom: "1px solid #e0e0e0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "white",
  },
  userName: {
    fontWeight: "600",
    fontSize: "14px",
    marginBottom: "4px",
  },
  userStatus: {
    fontSize: "12px",
    color: "#666",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#4caf50",
  },
  statusDotOnline: {
    background: "#4caf50",
  },
  statusDotOffline: {
    background: "#999",
  },
  logoutButton: {
    padding: "6px 12px",
    background: "#f0f0f0",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "12px",
  },

  tabs: {
    display: "flex",
    borderBottom: "1px solid #e0e0e0",
    background: "white",
  },
  tab: {
    flex: 1,
    padding: "12px",
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: "500",
    color: "#666",
  },
  tabActive: {
    color: "#667eea",
    borderBottomColor: "#667eea",
  },

  list: {
    flex: 1,
    overflowY: "auto",
  },
  listHeader: {
    padding: "15px 20px",
    borderBottom: "1px solid #e0e0e0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "white",
  },
  refreshButton: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "16px",
  },
  listItem: {
    padding: "15px 20px",
    borderBottom: "1px solid #f0f0f0",
    cursor: "pointer",
    transition: "background 0.2s",
    background: "white",
  },
  listItemActive: {
    background: "#e8eaf6",
  },
  listItemContent: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  listItemTitle: {
    fontWeight: "500",
    fontSize: "14px",
  },
  badge: {
    background: "#667eea",
    color: "white",
    padding: "2px 8px",
    borderRadius: "12px",
    fontSize: "11px",
    fontWeight: "600",
  },

  emptyState: {
    padding: "40px 20px",
    textAlign: "center",
    color: "#999",
    fontSize: "14px",
  },

  // Contact components
  searchBox: {
    padding: "15px",
    display: "flex",
    gap: "8px",
    background: "white",
    borderBottom: "1px solid #e0e0e0",
  },
  searchInput: {
    flex: 1,
    padding: "8px 12px",
    border: "1px solid #ddd",
    borderRadius: "4px",
    fontSize: "13px",
  },
  searchButton: {
    padding: "8px 16px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
  },
  searchResults: {
    background: "#f0f0f0",
    borderBottom: "1px solid #e0e0e0",
  },
  searchResultsTitle: {
    padding: "10px 20px",
    fontSize: "12px",
    fontWeight: "600",
    color: "#666",
  },
  searchResultItem: {
    padding: "10px 20px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "white",
    borderBottom: "1px solid #f0f0f0",
  },
  addButton: {
    padding: "4px 12px",
    background: "#4caf50",
    color: "white",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "12px",
  },
  contactItem: {
    padding: "15px 20px",
    borderBottom: "1px solid #f0f0f0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "white",
  },
  contactName: {
    fontWeight: "500",
    fontSize: "14px",
    marginBottom: "4px",
  },
  contactStatus: {
    fontSize: "12px",
    color: "#666",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  dmButton: {
    padding: "6px 12px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "12px",
  },

  // Chat area
  emptyChatState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    color: "#999",
  },
  emptyChatIcon: {
    fontSize: "64px",
    marginBottom: "20px",
  },
  emptyChatText: {
    fontSize: "16px",
  },

  chatHeader: {
    padding: "20px",
    borderBottom: "1px solid #e0e0e0",
    background: "white",
  },
  chatTitle: {
    fontWeight: "600",
    fontSize: "18px",
    marginBottom: "4px",
  },
  typingIndicator: {
    fontSize: "12px",
    color: "#999",
    fontStyle: "italic",
  },

  messagesContainer: {
    flex: 1,
    overflowY: "auto",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    background: "#f8f9fa",
  },
  loading: {
    textAlign: "center",
    color: "#999",
    padding: "40px",
  },
  noMessages: {
    textAlign: "center",
    color: "#999",
    padding: "40px",
  },
  message: {
    maxWidth: "70%",
    padding: "10px 14px",
    borderRadius: "12px",
    fontSize: "14px",
  },
  messageOwn: {
    alignSelf: "flex-end",
    background: "#667eea",
    color: "white",
  },
  messageOther: {
    alignSelf: "flex-start",
    background: "white",
    border: "1px solid #e0e0e0",
  },
  messageSender: {
    fontSize: "11px",
    fontWeight: "600",
    marginBottom: "4px",
    color: "#667eea",
  },
  messageContent: {
    marginBottom: "4px",
    wordWrap: "break-word",
  },
  messageTime: {
    fontSize: "10px",
    opacity: 0.7,
  },

  inputContainer: {
    padding: "20px",
    borderTop: "1px solid #e0e0e0",
    display: "flex",
    gap: "10px",
    background: "white",
  },
  messageInput: {
    flex: 1,
    padding: "12px",
    border: "1px solid #ddd",
    borderRadius: "24px",
    fontSize: "14px",
  },
  sendButton: {
    padding: "12px 24px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "24px",
    cursor: "pointer",
    fontWeight: "600",
  },
};

export default App;
