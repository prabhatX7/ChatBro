# ChatBro — private end-to-end-encrypted chat (MERN)

## 1. Goal
A tiny, closed chat app for you and your friends. Nobody else can read the messages — not even the person who runs the server.

## 2. Requirements
| Need | How it is met |
|---|---|
| MERN | MongoDB + Express + React (Vite) + Node |
| Email/password sign-up and login | JWT sessions; password is never sent to the server (see §4) |
| Models | `User` (messages embedded in it) and `Group` (one sign-up code per folder), see §5 |
| End-to-end encryption | WebCrypto in the browser: ECDH P-256 keys, AES-256-GCM |
| Share images, mp3, mp4, any file | Files are encrypted in the browser, then uploaded as opaque blobs |
| Desktop pop-up when a friend sends something | Socket.IO event, decrypted locally, shown with the browser Notification API: "<name> sent this" |
| Only the people I let in | Sign-up requires a group code that the admin generated |
| Admin | The account whose email is `ADMIN_EMAIL` in `server/.env`. Created once with `ADMIN_SETUP_CODE`; the admin's password is chosen at sign-up |
| One code per folder (group) | The admin makes groups in the app; each has its own code. Signing up with a code puts you in that group |
| Members only see their own group | Enforced on the server (user list, sending, live presence, typing), not just hidden in the UI |
| Everyone can reach the admin; admin sees all groups and can message anyone | The admin is visible to every member; the admin's list is shown grouped in folders |
| Cursor goes to the message box on opening a chat or starting a reply | `Composer` focuses its textarea on mount and whenever a reply starts |
| Click a message to reply to it | Clicking a message bubble starts a reply (buttons, players and text selection are excluded) |
| Black UI, glowing violet borders | Pure `#000` background, violet borders with layered glow |

## 3. Architecture
```
Browser A (React)                     Server (Express)                  Browser B (React)
 keys, encrypt/decrypt   --HTTPS-->   auth, store ciphertext   <--HTTPS--   keys, encrypt/decrypt
        ^                              MongoDB: User docs                         ^
        +------------- Socket.IO (realtime event: "new ciphertext") --------------+
```
The server only ever handles ciphertext and public keys.

## 4. Security design
1. **Identity key** – each user generates an ECDH P-256 key pair in the browser at sign-up.
2. **Password handling** – `PBKDF2-SHA256 (310k rounds, salt = app+email)` → master secret → `HKDF` splits it into
   - `authSecret` (sent to the server, which stores only `bcrypt(authSecret)`), and
   - `wrapKey` (never leaves the browser).
   The server never sees the real password, and cannot derive `wrapKey`.
3. **Private key storage** – the private key is wrapped with `wrapKey` (AES-GCM) and stored on the server so you can log in from another device. Locally it is kept as a **non-extractable** CryptoKey in IndexedDB.
4. **Messages** – `ECDH(myPrivate, friendPublic)` → `HKDF` → AES-256-GCM key shared by the pair. Fresh random IV per message. The sender→recipient ids are bound in as AAD so the server cannot flip a message's direction.
5. **Files** – encrypted in the browser with the same pair key before upload. File name, type and size travel inside the encrypted message payload, so the server only sees an opaque blob.
6. **Safety number** – a fingerprint of both public keys shown in the chat header. Compare it with your friend once (call or in person) to rule out a tampered key exchange.
7. **Transport hardening** – helmet + strict CSP, rate-limited auth, JWT, per-file authorization.

### Admin and groups: who can see whom
| Who | Sees | Can message |
|---|---|---|
| Admin | every approved member, shown in folders by group | anyone approved |
| Member | the admin + members of the **same** group | the admin + their own group |
| Member with no group ("only me") | the admin only | the admin only |
| Waiting for approval | nobody | nobody (cannot log in) |

- One rule, `canChat(a, b)` in `server/src/services/access.js` (unit-tested): false if either is pending; true if either is the admin; otherwise true only when both have the same non-empty group.
- It is applied on the server to: `GET /api/users` (only the allowed people are ever sent to a browser), `POST /api/messages/:peerId`, `PUT /api/users/pins/:peerId`, typing/speaking relays, and who gets `user:new` / `presence` events (Socket.IO rooms `admins` and `group:<id>`).
- The admin role is read from the database on every admin request, never from the login token.
- **The admin cannot read other people's chats.** Messages are end-to-end encrypted between the two people, so the admin sees who is in each group but not what they write. This is deliberate: giving the admin a way to read chats would break the encryption for everyone.
- **Admin sign-up:** only the `ADMIN_EMAIL` address can become the admin, and only with `ADMIN_SETUP_CODE`, so nobody can grab the admin email first. All sign-up failures show the same "That code is not valid" message so it does not reveal which email is the admin's.
- **Group codes:** 10 random characters (no 0/O/1/I), compared without case or dashes. The admin can close a code (no new sign-ups), replace it with a new one, or delete an empty group. Existing members stay when a code is closed or replaced.
- **Approval:** member sign-ups are stored with `status: 'pending'` and no token is issued. Login for a pending account returns 403 (after the password check). The admin gets a `signup:pending` event, then approves (requested group, another group, or "only me") or rejects (account deleted). The server decides the destination in `services/approval.js` (unit-tested).
- **Private codes:** a group with `private: true` never puts anyone in a shared group. Approved people get `group: null` and `via: <private group>`, so they see only the admin, and the admin sees them in that code's folder. The admin can also move any member to another group or "only me" (`PATCH /api/admin/members/:id`); the person is told to reconnect (`session:refresh`) so live updates follow the new group.
- **Upgrading:** accounts made before groups existed are moved into an "Original group" on the first start. That group's code is the old `INVITE_CODE`, so the old code keeps working until the admin closes it.

### What the server can still see (metadata)
Who talks to whom, when, ciphertext sizes, and that a message has an attachment. Not the content, names, or file types. The server (and so the admin screen) also knows which group each member is in.

### What is encrypted vs. plain (v2 features)
| Thing | Stored as |
|---|---|
| Text, file/voice metadata, **reply target id**, voice waveform | inside the encrypted message payload |
| **Emoji reactions** | each reaction is its own AES-GCM blob (AAD `react:<messageId>:<reactorId>`) |
| Delivered / seen times, pinned flag, unsent flag | plain metadata on the message (the server needs them to relay status) |
| Pinned chats | plain list of friend ids on your `User` document |
| Typing / speaking | never stored, relayed over Socket.IO only |

### Known limits (honest list)
- No forward secrecy (static keys per user). A Double-Ratchet upgrade is the next step if needed.
- Forgetting the password = history is unrecoverable (that is what E2EE means).
- A malicious *server operator* could swap public keys at first contact → verify the safety number.
- Pop-ups work while the app tab/browser is open (even in the background). Pop-ups with the browser fully closed need Web Push (future).
- Needs HTTPS (or localhost) because WebCrypto is only available in secure contexts.

## 5. Data model — `User` (messages embedded) and `Group`
```
Group { name, code (unique, upper-case, no dashes), active, createdAt }   // one folder + its sign-up code

User {
  name, email (unique), authHash (bcrypt),
  publicKey (JWK string), encPrivateKey { iv, data },
  role: 'member' | 'admin',                      // admin = the ADMIN_EMAIL account
  group: ObjectId | null,                        // the folder a member belongs to (admin has none)
  pinnedChats: [ObjectId],                       // friends pinned to the top of this user's list
  messages: [ {
    _id, from, to, peer, iv, ct, fileId?, createdAt,
    deliveredAt?, seenAt?,                       // receipts
    pinned, pinnedAt?,                           // shared by both people
    unsent,                                      // iv/ct/fileId wiped, tombstone kept
    reactions: [ { by, iv, ct } ]                // encrypted emoji, one per person
  } ]                                            // embedded
}
```
Each message is stored in both participants' documents (same ciphertext), so either person can reload history. Receipt, pin, unsend and reaction changes are written to both copies. Trade-off of "one model": fine for a few friends; split into a `Message` collection if it ever grows large.

## 6. API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | create account (needs an open group's code, or `ADMIN_SETUP_CODE` for the admin email) |
| POST | `/api/auth/login` | returns JWT + wrapped private key + role |
| GET | `/api/auth/me` | current user (with role) |
| GET | `/api/users` | the people **you may see** + their public keys + your `pinnedChats` (admin: everyone, tagged with their group) |
| GET | `/api/admin/groups` | **admin only:** all groups with codes and members, plus `privateOthers` (approved people with no group) |
| GET | `/api/admin/pending` | **admin only:** people waiting for approval |
| POST | `/api/admin/pending/:id/approve` | **admin only:** body none = as requested, `{group:null}` = only me, `{group:id}` |
| POST | `/api/admin/pending/:id/reject` | **admin only:** delete the request |
| PATCH | `/api/admin/members/:id` | **admin only:** move to `{group: id|null}` |
| POST | `/api/admin/groups` | **admin only:** create a group (`{name, private}`), returns it with a new code |
| PATCH | `/api/admin/groups/:id` | **admin only:** rename, open/close the code (`{active}`), or `{regenerate: true}` for a new code |
| DELETE | `/api/admin/groups/:id` | **admin only:** delete an empty group |
| PUT | `/api/users/pins/:peerId` | pin / unpin a chat (`{pinned}`) |
| GET | `/api/messages/:peerId` | encrypted history |
| POST | `/api/messages/:peerId` | store + relay a ciphertext |
| POST | `/api/messages/:peerId/seen` | mark the friend's messages as seen |
| DELETE | `/api/messages/:peerId/:msgId` | unsend your own message (both sides) |
| PUT | `/api/messages/:peerId/:msgId/react` | set / clear your encrypted reaction |
| PUT | `/api/messages/:peerId/:msgId/pin` | pin / unpin a message (`{pinned}`) |
| DELETE | `/api/messages/:peerId` | delete the whole chat from *your* account |
| POST | `/api/files` | upload encrypted blob (≤ `MAX_FILE_MB`) |
| GET | `/api/files/:id` | download (only participants) |

Socket events (server → client): `message`, `message:update`, `status` (delivered/seen), `activity` (typing/speaking), `chat:deleted`, `chats:pinned`, `presence`, `presence:list`, `user:new`, `signup:pending`, `admin:changed`, `users:changed`, `session:refresh`.
Client → server: `activity` `{to, kind: 'typing'|'speaking', on}` (rate-limited, validated, never stored).

Delivery rules: a message is **sent** once stored; **delivered** as soon as the friend has any open connection (or, if they were offline, when they next connect); **seen** when the friend has that chat open in a focused window.

## 7. UI spec
**Admin:** a "Groups & codes" screen (button in the sidebar, admin only) to create groups, copy each group's code, close/reopen/replace it, rename or delete a group, and approve or reject people waiting to join (choosing a group, or "Only me"), make private one-to-one codes, move members between groups, and open a chat with any member. The admin's chat list is shown in folders, one per group. Members see the admin first, with an "Admin" badge.

**Composer:** the cursor is put in the message box when a chat opens, when a reply starts (by click, by the ↩ button or by the menu), after sending, after choosing files and after a voice note. `Esc` cancels a reply. Clicking a message (not its buttons, players or selected text) starts a reply to it; messages that are still sending, unsent or broken cannot be replied to.

Message actions live in a hover toolbar (☺ react, ↩ reply, ⋯ more) that is always faintly visible on touch screens. Black (`#000`) only. Every surface is outlined with a violet border plus layered glow (`box-shadow`); the active chat and focused inputs glow brighter. Text is pale lavender. Responsive: sidebar + chat on desktop, single pane on phones.

## 8. Checklist
- [x] Plan
- [x] Backend (Express, Mongo `User` model, auth, messages, encrypted files, Socket.IO)
- [x] Crypto layer + 7 unit tests (all passing)
- [x] React UI (black + glowing violet, pop-ups, uploads, media)
- [x] README
- [x] v2 features: message status, typing/speaking, voice messages, unsend, delete chat, reactions, pins, replies
- [x] Rename to ChatBro
- [x] v3: admin + groups (per-group codes, scoped visibility, admin screen, migration of existing members)
- [x] v3: cursor auto-focus in the message box, click a message to reply
- [x] v4: admin approval of sign-ups, private (one-to-one) codes, "only me", move members
- [ ] First end-to-end run with MongoDB and two browsers (see "Verification status")

### Verification status
- Verified: 7 crypto tests and 29 server tests pass (visibility rules including pending and "only me", approval destinations, code generation and matching, the `.env` upgrade script). Every server and client source file parses, and a stricter pass finds no undefined names or bad imports between files.
- Verified earlier (v2 UI, by a previous builder): the React client was bundled and driven in headless Chromium against a mocked API for status ticks, typing/speaking, voice, reactions, replies, pins, unsend and delete chat.
- **Not yet run:** `npm install`, the Vite build, and the real Express + MongoDB server. This includes everything new in v3 and v4 (approval flow, private codes, moving members, the pending list and its pop-up): `routes/admin.js`, `routes/auth.js` (group codes), `routes/users.js`, `socket.js` (rooms), `services/bootstrap.js`, and the admin screen, sidebar folders, auto-focus and click-to-reply in the browser. The sandbox this was written in cannot reach the npm registry, MongoDB or a React install, so the first real run is on your machine. Follow the checklist in the README.
- Internal key-derivation labels still say `veil-chat` on purpose (see the note in `client/src/crypto.js`): changing them would lock existing accounts out.

## 9. Later
Remove a member, ask a waiting person to be notified when approved, several admins, Web Push for closed-browser pop-ups, forward secrecy (ratchet), a switch to turn read receipts off, "delete for everyone" on whole chats, message editing, group chats between members.