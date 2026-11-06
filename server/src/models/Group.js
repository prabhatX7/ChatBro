import mongoose from 'mongoose';

const { Schema } = mongoose;

// A group is a "folder" of members who signed up with the same code.
// Members only see each other (plus the admin). The admin creates and manages groups.
const groupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    // Stored without dashes/lowercase (see services/codes.js). Whoever signs up with it joins this group.
    code: { type: String, required: true, unique: true, maxlength: 40 },
    // When false the code stops working for NEW sign-ups. Existing members stay.
    active: { type: Boolean, default: true },
    // A private code is for individuals: everyone who joins with it chats only with the admin, never with each
    // other. One private code can be given to any number of people.
    private: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model('Group', groupSchema);
