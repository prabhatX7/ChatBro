import mongoose from 'mongoose';

const { Schema } = mongoose;

// A reaction is an emoji encrypted in the browser with the pair key; the server cannot read it.
const reactionSchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, required: true },
    iv: { type: String, required: true, maxlength: 32 },
    ct: { type: String, required: true, maxlength: 400 },
  },
  { _id: false }
);

// Everything the server stores about a conversation's content is ciphertext.
// Messages are embedded in each participant's User document (the app's only model).
const messageSchema = new Schema({
  from: { type: Schema.Types.ObjectId, required: true },
  to: { type: Schema.Types.ObjectId, required: true },
  peer: { type: Schema.Types.ObjectId, required: true }, // the other participant, from this document owner's view
  // iv/ct are emptied when a message is unsent, so they are only required for live messages.
  iv: { type: String, maxlength: 32, default: '', required: function () { return !this.unsent; } },
  ct: { type: String, maxlength: 100000, default: '', required: function () { return !this.unsent; } }, // base64 AES-GCM ciphertext (text, replies, file/voice metadata)
  fileId: { type: String, default: null }, // opaque id of an encrypted blob on disk
  createdAt: { type: Date, default: Date.now },

  // Delivery receipts (metadata only, no content).
  deliveredAt: { type: Date, default: null },
  seenAt: { type: Date, default: null },

  // Shared by both people in the chat.
  pinned: { type: Boolean, default: false },
  pinnedAt: { type: Date, default: null },
  unsent: { type: Boolean, default: false },
  reactions: { type: [reactionSchema], default: [] },
});

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 200 },
    authHash: { type: String, required: true }, // bcrypt of the client-derived auth secret (never the password)
    publicKey: { type: String, required: true }, // ECDH P-256 public key (JWK JSON string)
    encPrivateKey: {
      // private key wrapped in the browser with a key the server never sees
      iv: { type: String, required: true },
      data: { type: String, required: true },
    },
    // 'admin' is whoever owns the ADMIN_EMAIL account. Everyone else is a member of exactly one group.
    // (Accounts created before groups existed have neither field; the server fills them in at start-up.)
    role: { type: String, enum: ['member', 'admin'], default: 'member' },
    group: { type: Schema.Types.ObjectId, ref: 'Group', default: null, index: true },
    // 'pending' = signed up, waiting for the admin. Pending accounts cannot log in and nobody can see them.
    // (Accounts from before approvals existed have no status; the server treats those as active.)
    status: { type: String, enum: ['pending', 'active'], default: 'active' },
    requestedGroup: { type: Schema.Types.ObjectId, ref: 'Group', default: null }, // the code used, while pending
    // For someone who joined with a PRIVATE code: that code's group. Display only, gives no visibility.
    via: { type: Schema.Types.ObjectId, ref: 'Group', default: null },
    pinnedChats: { type: [Schema.Types.ObjectId], default: [] }, // friends this user pinned to the top of their list
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model('User', userSchema);
