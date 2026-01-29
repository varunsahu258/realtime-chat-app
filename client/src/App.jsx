import { useEffect, useMemo, useRef, useState } from "react";
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
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showEditRoomModal, setShowEditRoomModal] = useState(false);
  
  // Chat state
  const [rooms, setRooms] = useState([]);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  
  // Contact state
  const [contacts, setContacts] = useState([]);
  const [contactRequests, setContactRequests] = useState([]);
  const [searchEmail, setSearchEmail] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  
  // Group invite state
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSearchResults, setInviteSearchResults] = useState([]);
  const [inviteLink, setInviteLink] = useState("");
  
  // Edit room state
  const [editRoomName, setEditRoomName] = useState("");
  
  // Typing indicators
  const [typingUsers, setTypingUsers] = useState(new Set());
  const typingTimeoutRef = useRef(null);
  
  // Online status
  const [onlineUsers, setOnlineUsers] = useState(new Set());

  // Group Rooms state
  const [createRoomName, setCreateRoomName] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");

  // Profile state
  const [profilePicture, setProfilePicture] = useState(null);
  const [profilePicturePreview, setProfilePicturePreview] = useState(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");

  const messagesEndRef = useRef(null);

  const [activityTick, setActivityTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setActivityTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

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
      
      // Clear auth form
      setEmail("");
      setPassword("");
      setName("");
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
      
      // Clear auth form
      setEmail("");
      setPassword("");
    } catch (err) {
      alert("Login failed: " + (err?.message || err));
      console.error(err);
    }
  };

  const logout = async () => {
    try {
      await account.deleteSession("current");
      // Clear all chat/UI state so nothing shows below auth form after logout
      setUser(null);
      setRooms([]);
      setMessages([]);
      setContacts([]);
      setContactRequests([]);
      setSelectedRoom(null);
      setActiveView("rooms");
      setMessageInput("");
      setSearchResults([]);
      setSearchEmail("");
      setInviteSearchResults([]);
      setInviteEmail("");
      setShowCreateRoom(false);
      setShowInviteModal(false);
      setShowEditRoomModal(false);
      setTypingUsers(new Set());
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

  const loadContactRequests = async () => {
    try {
      const res = await fetch(`${API_URL}/api/contacts/requests?userId=${user.$id}`);
      const data = await res.json();
      setContactRequests(data.requests || []);
    } catch (err) {
      console.error("Failed to load contact requests:", err);
    }
  };

  useEffect(() => {
    if (user) {
      loadRooms();
      loadContacts();
      loadContactRequests();
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

  const sendContactRequest = async (contactEmail) => {
    try {
      const res = await fetch(`${API_URL}/api/contacts/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.$id, contactEmail }),
      });

      if (res.ok) {
        alert("Contact request sent!");
        setSearchEmail("");
        setSearchResults([]);
      } else {
        const data = await res.json();
        alert(data.error || "Failed to send contact request");
      }
    } catch (err) {
      console.error("Contact request error:", err);
      alert("Failed to send contact request");
    }
  };

  const acceptContactRequest = async (requestId, contactId) => {
    try {
      const res = await fetch(`${API_URL}/api/contacts/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, userId: user.$id }),
      });

      if (res.ok) {
        loadContacts();
        loadContactRequests();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to accept request");
      }
    } catch (err) {
      console.error("Accept request error:", err);
    }
  };

  const rejectContactRequest = async (requestId) => {
    try {
      const res = await fetch(`${API_URL}/api/contacts/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, userId: user.$id }),
      });

      if (res.ok) {
        loadContactRequests();
      }
    } catch (err) {
      console.error("Reject request error:", err);
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

  const formatLastActivity = (isoDate) => {
    if (!isoDate) return "No messages yet";
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) {
      if (diffMins < 5) return "5 min ago";
      if (diffMins < 15) return "15 min ago";
      if (diffMins < 30) return "30 min ago";
      return "1 hr ago";
    }
    if (diffHours < 24) return `${diffHours} hr ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} wk ago`;
    return date.toLocaleDateString();
  };

  const roomsSortedByLastMessage = [...rooms]
    .filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i)
    .sort((a, b) => {
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });

  const roomLastActivityLabels = useMemo(() => {
    const map = {};
    rooms.forEach((room) => {
      map[room.id] = formatLastActivity(room.last_message_at);
    });
    return map;
  }, [rooms, activityTick]);

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

  const generateInviteLink = () => {
    if (!selectedRoom) return;
    const link = `${window.location.origin}/invite/${selectedRoom}`;
    setInviteLink(link);
  };

  const searchUsersForInvite = async () => {
    if (!inviteEmail.trim()) return;

    try {
      const res = await fetch(
        `${API_URL}/api/users/search?email=${encodeURIComponent(inviteEmail)}`
      );
      const data = await res.json();
      setInviteSearchResults(data.users || []);
    } catch (err) {
      console.error("Search failed:", err);
    }
  };

  const inviteUserToRoom = async (userId) => {
    try {
      const res = await fetch(`${API_URL}/api/rooms/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          roomId: selectedRoom, 
          userId: userId,
          invitedBy: user.$id
        }),
      });

      if (res.ok) {
        alert("User invited successfully!");
        setInviteEmail("");
        setInviteSearchResults([]);
        setShowInviteModal(false);
      } else {
        const data = await res.json();
        alert(data.error || "Failed to invite user");
      }
    } catch (err) {
      console.error("Invite user error:", err);
      alert("Failed to invite user");
    }
  };

  const updateRoomName = async () => {
    if (!editRoomName.trim()) return alert("Enter room name");

    try {
      const res = await fetch(`${API_URL}/api/rooms/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          roomId: selectedRoom, 
          name: editRoomName,
          userId: user.$id
        }),
      });

      if (res.ok) {
        alert("Room name updated!");
        setEditRoomName("");
        setShowEditRoomModal(false);
        loadRooms();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to update room name");
      }
    } catch (err) {
      console.error("Update room error:", err);
      alert("Failed to update room name");
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      alert("✅ Copied to clipboard!");
    } catch (err) {
      console.error("Copy failed:", err);
      alert("❌ Copy failed. Please copy manually.");
    }
  };

  // ====================================
  // PROFILE FUNCTIONS
  // ====================================

  const handleProfilePictureChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setProfilePicture(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfilePicturePreview(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const updateProfile = async () => {
    try {
      // In a real app, you'd upload the profile picture to storage
      // and update user profile via API
      
      if (newDisplayName.trim()) {
        // Update display name logic here
        alert("Profile updated! (In production, this would save to backend)");
        setEditingProfile(false);
      }
    } catch (err) {
      console.error("Update profile error:", err);
      alert("Failed to update profile");
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
  // RENDER: PROFILE PAGE
  // ====================================

  if (activeView === "profile") {
    return (
      <div style={styles.container}>
        <div style={styles.sidebar}>
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

          <div style={styles.navTabs}>
            <button
              style={styles.navTab}
              onClick={() => setActiveView("rooms")}
            >
              <span style={styles.navIcon}>💬</span>
              <span>Chats</span>
            </button>
            <button
              style={styles.navTab}
              onClick={() => setActiveView("contacts")}
            >
              <span style={styles.navIcon}>👥</span>
              <span>Contacts</span>
            </button>
            <button
              style={{...styles.navTab, ...styles.navTabActive}}
              onClick={() => setActiveView("profile")}
            >
              <span style={styles.navIcon}>⚙️</span>
              <span>Settings</span>
            </button>
          </div>
        </div>

        <div style={styles.chatArea}>
          <div style={styles.profileContainer}>
            <div style={styles.profileHeader}>
              <h2 style={styles.profileTitle}>Profile Settings</h2>
            </div>

            <div style={styles.profileContent}>
              <div style={styles.profileSection}>
                <h3 style={styles.sectionTitle}>Profile Picture</h3>
                <div style={styles.profilePictureSection}>
                  <div style={styles.largeAvatar}>
                    {profilePicturePreview ? (
                      <img src={profilePicturePreview} alt="Profile" style={styles.profileImage} />
                    ) : (
                      user.name ? user.name.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()
                    )}
                  </div>
                  <div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleProfilePictureChange}
                      style={styles.fileInput}
                      id="profile-pic"
                    />
                    <label htmlFor="profile-pic" style={styles.uploadButton}>
                      Upload New Picture
                    </label>
                    <p style={styles.helpText}>JPG, PNG or GIF. Max size 2MB</p>
                  </div>
                </div>
              </div>

              <div style={styles.profileSection}>
                <h3 style={styles.sectionTitle}>Account Information</h3>
                <div style={styles.infoGroup}>
                  <label style={styles.infoLabel}>Display Name</label>
                  {editingProfile ? (
                    <input
                      style={styles.input}
                      value={newDisplayName}
                      onChange={(e) => setNewDisplayName(e.target.value)}
                      placeholder={user.name || "Enter display name"}
                    />
                  ) : (
                    <div style={styles.infoValue}>{user.name || "Not set"}</div>
                  )}
                </div>

                <div style={styles.infoGroup}>
                  <label style={styles.infoLabel}>Email</label>
                  <div style={styles.infoValue}>{user.email}</div>
                </div>

                <div style={styles.infoGroup}>
                  <label style={styles.infoLabel}>User ID</label>
                  <div style={styles.infoValue}>{user.$id}</div>
                </div>

                {editingProfile ? (
                  <div style={styles.buttonGroup}>
                    <button style={styles.saveButton} onClick={updateProfile}>
                      Save Changes
                    </button>
                    <button 
                      style={styles.cancelButton} 
                      onClick={() => {
                        setEditingProfile(false);
                        setNewDisplayName("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button 
                    style={styles.editButton} 
                    onClick={() => {
                      setEditingProfile(true);
                      setNewDisplayName(user.name || "");
                    }}
                  >
                    Edit Profile
                  </button>
                )}
              </div>

              <div style={styles.profileSection}>
                <h3 style={styles.sectionTitle}>Preferences</h3>
                <div style={styles.preferenceItem}>
                  <div>
                    <div style={styles.preferenceLabel}>Notifications</div>
                    <div style={styles.preferenceDesc}>Receive notifications for new messages</div>
                  </div>
                  <label style={styles.switch}>
                    <input type="checkbox" defaultChecked />
                    <span style={styles.slider}></span>
                  </label>
                </div>

                <div style={styles.preferenceItem}>
                  <div>
                    <div style={styles.preferenceLabel}>Sound</div>
                    <div style={styles.preferenceDesc}>Play sound for incoming messages</div>
                  </div>
                  <label style={styles.switch}>
                    <input type="checkbox" defaultChecked />
                    <span style={styles.slider}></span>
                  </label>
                </div>
              </div>

              <div style={styles.profileSection}>
                <h3 style={styles.sectionTitle}>Danger Zone</h3>
                <button style={styles.logoutButtonLarge} onClick={logout}>
                  Logout
                </button>
              </div>
            </div>
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
            {contactRequests.length > 0 && (
              <span style={styles.requestBadge}>{contactRequests.length}</span>
            )}
          </button>
          <button
            style={styles.navTab}
            onClick={() => setActiveView("profile")}
          >
            <span style={styles.navIcon}>⚙️</span>
            <span>Settings</span>
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
                  <label style={styles.panelLabel}>Join via Invite Link</label>
                  <div style={styles.inputRow}>
                    <input
                      style={styles.panelInput}
                      placeholder="Paste invite link"
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
              {roomsSortedByLastMessage.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={styles.emptyIcon}>📭</div>
                  <p style={styles.emptyText}>No chats yet</p>
                  <p style={styles.emptySubtext}>Start a conversation!</p>
                </div>
              ) : (
                roomsSortedByLastMessage.map((room) => (
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
                        {roomLastActivityLabels[room.id]}
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

            {/* Contact Requests */}
            {contactRequests.length > 0 && (
              <div style={styles.requestsSection}>
                <div style={styles.requestsHeader}>
                  <span style={styles.requestsTitle}>Requests</span>
                  <span style={styles.requestCount}>{contactRequests.length}</span>
                </div>
                {contactRequests.map((request) => (
                  <div key={request.id} style={styles.requestItem}>
                    <div style={styles.requestAvatar}>
                      {request.email.charAt(0).toUpperCase()}
                    </div>
                    <div style={styles.requestInfo}>
                      <div style={styles.requestName}>{request.email}</div>
                      <div style={styles.requestActions}>
                        <button
                          style={styles.acceptBtn}
                          onClick={() => acceptContactRequest(request.id, request.user_id)}
                        >
                          Accept
                        </button>
                        <button
                          style={styles.rejectBtn}
                          onClick={() => rejectContactRequest(request.id)}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

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
                        onClick={() => sendContactRequest(result.email)}
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
            <div style={styles.chatHeader}>
              <div style={styles.chatHeaderLeft}>
                <div style={styles.chatAvatar}>
                  {selectedRoomData?.type === "dm" ? "👤" : "👥"}
                </div>
                <div>
                  <div style={styles.chatTitle}>
                    {getRoomTitle(selectedRoomData)}
                  </div>
                  {typingUsers.size > 0 && (
                    <div style={styles.typingIndicator}>
                      <span style={styles.typingDots}></span>
                      typing...
                    </div>
                  )}
                </div>
              </div>

              {selectedRoomData?.type === "group" && (
                <div style={styles.headerActions}>
                  <button
                    style={styles.headerBtn}
                    onClick={() => {
                      setEditRoomName(selectedRoomData.name || "");
                      setShowEditRoomModal(true);
                    }}
                    title="Edit Room"
                  >
                    ✏️
                  </button>
                  <button
                    style={styles.headerBtn}
                    onClick={() => {
                      setShowInviteModal(true);
                      generateInviteLink();
                    }}
                    title="Invite Users"
                  >
                    ➕
                  </button>
                </div>
              )}
            </div>

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

      {/* INVITE MODAL */}
      {showInviteModal && (
        <div style={styles.modalOverlay} onClick={() => setShowInviteModal(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={styles.modalTitle}>Invite to {getRoomTitle(selectedRoomData)}</h3>
              <button style={styles.closeBtn} onClick={() => setShowInviteModal(false)}>
                ✕
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.modalSection}>
                <label style={styles.modalLabel}>Invite via Email</label>
                <div style={styles.inputRow}>
                  <input
                    style={styles.panelInput}
                    placeholder="Search by email..."
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchUsersForInvite()}
                  />
                  <button style={styles.panelBtn} onClick={searchUsersForInvite}>
                    Search
                  </button>
                </div>

                {inviteSearchResults.length > 0 && (
                  <div style={styles.inviteResults}>
                    {inviteSearchResults.map((result) => (
                      <div key={result.id} style={styles.inviteResultItem}>
                        <div style={styles.inviteResultAvatar}>
                          {result.email.charAt(0).toUpperCase()}
                        </div>
                        <div style={styles.inviteResultInfo}>
                          <div style={styles.inviteResultName}>{result.email}</div>
                        </div>
                        <button
                          style={styles.inviteBtn}
                          onClick={() => inviteUserToRoom(result.id)}
                        >
                          Invite
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={styles.divider}>
                <span style={styles.dividerText}>OR</span>
              </div>

              <div style={styles.modalSection}>
                <label style={styles.modalLabel}>Share Invite Link</label>
                <div style={styles.linkBox}>
                  <input
                    style={styles.linkInput}
                    value={inviteLink}
                    readOnly
                  />
                  <button
                    style={styles.copyLinkBtn}
                    onClick={() => copyToClipboard(inviteLink)}
                  >
                    Copy
                  </button>
                </div>
                <p style={styles.helpText}>
                  Share this link with anyone you want to invite to this room
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EDIT ROOM MODAL */}
      {showEditRoomModal && (
        <div style={styles.modalOverlay} onClick={() => setShowEditRoomModal(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h3 style={styles.modalTitle}>Edit Room Name</h3>
              <button style={styles.closeBtn} onClick={() => setShowEditRoomModal(false)}>
                ✕
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.modalSection}>
                <label style={styles.modalLabel}>Room Name</label>
                <input
                  style={styles.input}
                  placeholder="Enter new room name"
                  value={editRoomName}
                  onChange={(e) => setEditRoomName(e.target.value)}
                />
              </div>

              <button style={styles.saveButton} onClick={updateRoomName}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ====================================
// STYLES
// ====================================

const styles = {
  authContainer: {
    minHeight: "100vh",
    height: "100vh",
    overflow: "auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    padding: "20px",
    boxSizing: "border-box",
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
    position: "relative",
  },
  navTabActive: {
    background: "#f8fafc",
    color: "#667eea",
  },
  navIcon: {
    fontSize: "18px",
  },
  requestBadge: {
    position: "absolute",
    top: "8px",
    right: "8px",
    background: "#ef4444",
    color: "white",
    borderRadius: "10px",
    padding: "2px 6px",
    fontSize: "10px",
    fontWeight: "700",
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

  // Contact Requests
  requestsSection: {
    padding: "12px",
    background: "white",
    borderBottom: "1px solid #e2e8f0",
  },
  requestsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "12px",
  },
  requestsTitle: {
    fontSize: "13px",
    fontWeight: "600",
    color: "#64748b",
  },
  requestCount: {
    background: "#ef4444",
    color: "white",
    borderRadius: "10px",
    padding: "2px 8px",
    fontSize: "11px",
    fontWeight: "700",
  },
  requestItem: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px",
    background: "#f8fafc",
    borderRadius: "8px",
    marginBottom: "8px",
  },
  requestAvatar: {
    width: "36px",
    height: "36px",
    borderRadius: "8px",
    background: "#667eea",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    fontWeight: "600",
  },
  requestInfo: {
    flex: 1,
  },
  requestName: {
    fontSize: "13px",
    fontWeight: "600",
    marginBottom: "6px",
    color: "#1e293b",
  },
  requestActions: {
    display: "flex",
    gap: "6px",
  },
  acceptBtn: {
    padding: "4px 12px",
    background: "#10b981",
    color: "white",
    border: "none",
    borderRadius: "6px",
    fontSize: "11px",
    fontWeight: "600",
    cursor: "pointer",
  },
  rejectBtn: {
    padding: "4px 12px",
    background: "#ef4444",
    color: "white",
    border: "none",
    borderRadius: "6px",
    fontSize: "11px",
    fontWeight: "600",
    cursor: "pointer",
  },

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
  headerActions: {
    display: "flex",
    gap: "8px",
  },
  headerBtn: {
    width: "36px",
    height: "36px",
    borderRadius: "8px",
    background: "#f1f5f9",
    border: "none",
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

  // Modal Styles
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "white",
    borderRadius: "16px",
    width: "90%",
    maxWidth: "500px",
    maxHeight: "80vh",
    overflow: "auto",
  },
  modalHeader: {
    padding: "20px 24px",
    borderBottom: "1px solid #e2e8f0",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalTitle: {
    margin: 0,
    fontSize: "18px",
    fontWeight: "600",
    color: "#1e293b",
  },
  closeBtn: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    background: "#f1f5f9",
    border: "none",
    fontSize: "18px",
    cursor: "pointer",
    color: "#64748b",
  },
  modalBody: {
    padding: "24px",
  },
  modalSection: {
    marginBottom: "24px",
  },
  modalLabel: {
    display: "block",
    marginBottom: "12px",
    fontSize: "14px",
    fontWeight: "600",
    color: "#334155",
  },
  inviteResults: {
    marginTop: "12px",
    maxHeight: "200px",
    overflowY: "auto",
  },
  inviteResultItem: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px",
    background: "#f8fafc",
    borderRadius: "8px",
    marginBottom: "8px",
  },
  inviteResultAvatar: {
    width: "36px",
    height: "36px",
    borderRadius: "8px",
    background: "#667eea",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    fontWeight: "600",
  },
  inviteResultInfo: {
    flex: 1,
  },
  inviteResultName: {
    fontSize: "14px",
    fontWeight: "500",
    color: "#1e293b",
  },
  inviteBtn: {
    padding: "8px 16px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
  },
  divider: {
    textAlign: "center",
    position: "relative",
    margin: "24px 0",
  },
  dividerText: {
    background: "white",
    padding: "0 12px",
    color: "#94a3b8",
    fontSize: "12px",
    fontWeight: "600",
    position: "relative",
    zIndex: 1,
  },
  linkBox: {
    display: "flex",
    gap: "8px",
  },
  linkInput: {
    flex: 1,
    padding: "12px",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    fontSize: "13px",
    background: "#f8fafc",
  },
  copyLinkBtn: {
    padding: "12px 20px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  helpText: {
    marginTop: "8px",
    fontSize: "12px",
    color: "#94a3b8",
  },

  // Profile Page Styles
  profileContainer: {
    flex: 1,
    overflowY: "auto",
    background: "#f8fafc",
  },
  profileHeader: {
    padding: "32px 40px",
    background: "white",
    borderBottom: "1px solid #e2e8f0",
  },
  profileTitle: {
    margin: 0,
    fontSize: "24px",
    fontWeight: "700",
    color: "#1e293b",
  },
  profileContent: {
    padding: "32px 40px",
    maxWidth: "800px",
  },
  profileSection: {
    padding: "24px",
    background: "white",
    borderRadius: "12px",
    marginBottom: "24px",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)",
  },
  sectionTitle: {
    margin: "0 0 20px",
    fontSize: "16px",
    fontWeight: "600",
    color: "#1e293b",
  },
  profilePictureSection: {
    display: "flex",
    alignItems: "center",
    gap: "24px",
  },
  largeAvatar: {
    width: "100px",
    height: "100px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "40px",
    fontWeight: "600",
    overflow: "hidden",
  },
  profileImage: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  fileInput: {
    display: "none",
  },
  uploadButton: {
    display: "inline-block",
    padding: "10px 20px",
    background: "#667eea",
    color: "white",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    transition: "all 0.2s",
  },
  infoGroup: {
    marginBottom: "20px",
  },
  infoLabel: {
    display: "block",
    marginBottom: "8px",
    fontSize: "13px",
    fontWeight: "600",
    color: "#64748b",
  },
  infoValue: {
    padding: "12px 16px",
    background: "#f8fafc",
    borderRadius: "8px",
    fontSize: "14px",
    color: "#1e293b",
  },
  buttonGroup: {
    display: "flex",
    gap: "12px",
  },
  saveButton: {
    padding: "12px 24px",
    background: "#10b981",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
  },
  cancelButton: {
    padding: "12px 24px",
    background: "#f1f5f9",
    color: "#64748b",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
  },
  editButton: {
    padding: "12px 24px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
  },
  preferenceItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px",
    background: "#f8fafc",
    borderRadius: "8px",
    marginBottom: "12px",
  },
  preferenceLabel: {
    fontSize: "14px",
    fontWeight: "600",
    color: "#1e293b",
    marginBottom: "4px",
  },
  preferenceDesc: {
    fontSize: "12px",
    color: "#64748b",
  },
  switch: {
    position: "relative",
    display: "inline-block",
    width: "48px",
    height: "28px",
  },
  slider: {
    position: "absolute",
    cursor: "pointer",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "#e2e8f0",
    borderRadius: "34px",
    transition: "0.4s",
  },
  logoutButtonLarge: {
    width: "100%",
    padding: "14px",
    background: "#ef4444",
    color: "white",
    border: "none",
    borderRadius: "8px",
    fontSize: "15px",
    fontWeight: "600",
    cursor: "pointer",
    transition: "all 0.2s",
  },
};

// Add CSS animations
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
  
  input[type="checkbox"]:checked + .slider {
    background: #667eea;
  }
  
  .slider::before {
    position: absolute;
    content: "";
    height: 20px;
    width: 20px;
    left: 4px;
    bottom: 4px;
    background: white;
    border-radius: 50%;
    transition: 0.4s;
  }
  
  input[type="checkbox"]:checked + .slider::before {
    transform: translateX(20px);
  }
`;
document.head.appendChild(styleSheet);

export default App;
