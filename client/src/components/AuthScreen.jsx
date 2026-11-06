import { useState } from 'react';
import { api } from '../api.js';
import { askPermission } from '../notify.js';
import { cryptoAvailable, deriveCredentials, createIdentity, unwrapIdentity } from '../crypto.js';

export default function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', invite: '' });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const signup = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    askPermission(); // must be called from a click/submit so the browser will show the prompt

    if (!cryptoAvailable()) {
      setError('Encryption needs a secure page. Open this app over https:// (or on localhost).');
      return;
    }
    if (signup && form.password.length < 10) {
      setError('Use a password of at least 10 characters. It protects your encryption keys.');
      return;
    }

    setBusy(true);
    try {
      const email = form.email.trim().toLowerCase();
      setStatus('Deriving keys from your password…');
      const { authSecret, wrapKey } = await deriveCredentials(email, form.password);

      if (signup) {
        setStatus('Generating your encryption keys on this device…');
        const id = await createIdentity(wrapKey);
        const res = await api.register({
          name: form.name.trim(),
          email,
          authSecret,
          publicKey: id.publicKey,
          encPrivateKey: id.encPrivateKey,
          inviteCode: form.invite.trim(),
        });
        if (res.pending) {
          // Members wait for the admin. There is nothing to log in to yet.
          setNotice(
            'Request sent. The admin has to approve you before you can log in. Come back later and log in with the same email and password.'
          );
          setForm({ name: '', email, password: '', invite: '' });
          setMode('login');
          return;
        }
        await onAuthed({ user: res.user, privateKey: id.privateKey, token: res.token });
      } else {
        const res = await api.login({ email, authSecret });
        setStatus('Unlocking your keys…');
        let privateKey;
        try {
          privateKey = await unwrapIdentity(wrapKey, res.encPrivateKey);
        } catch {
          throw new Error('Could not unlock your keys with that password.');
        }
        await onAuthed({ user: res.user, privateKey, token: res.token });
      }
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit} autoComplete="on">
        <div className="auth-logo">
          <span className="logo big">ChatBro</span>
          <p className="muted">Private chat. End-to-end encrypted. Just us.</p>
        </div>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!signup} className={!signup ? 'on' : ''} onClick={() => setMode('login')}>
            Log in
          </button>
          <button type="button" role="tab" aria-selected={signup} className={signup ? 'on' : ''} onClick={() => setMode('signup')}>
            Sign up
          </button>
        </div>

        {signup && (
          <label className="field">
            <span>Your name</span>
            <input value={form.name} onChange={set('name')} maxLength={40} required autoComplete="nickname" placeholder="What your friend sees" />
          </label>
        )}

        <label className="field">
          <span>Email</span>
          <input type="email" value={form.email} onChange={set('email')} required autoComplete="email" placeholder="you@example.com" />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            autoComplete={signup ? 'new-password' : 'current-password'}
            placeholder={signup ? 'At least 10 characters' : 'Your password'}
          />
        </label>

        {signup && (
          <label className="field">
            <span>Group code</span>
            <input value={form.invite} onChange={set('invite')} required autoComplete="off" placeholder="The code the admin gave you" />
            <small className="hint">The admin has to approve you before you can log in. You will only see the people the admin puts you with, plus the admin. Are you the admin? Sign up with your admin email and your admin setup code here.</small>
          </label>
        )}

        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        <button className="btn wide primary" type="submit" disabled={busy}>
          {busy ? status || 'Working…' : signup ? 'Create account' : 'Log in'}
        </button>

        <p className="fineprint">
          Your password never leaves this device. Encryption keys are created here, and the server only stores
          scrambled data. {signup && 'If you forget your password, your old messages cannot be recovered.'}
        </p>
      </form>
    </div>
  );
}
