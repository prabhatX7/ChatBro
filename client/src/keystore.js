// Keeps the unlocked private key between page reloads as a NON-EXTRACTABLE CryptoKey in IndexedDB:
// scripts can use it to decrypt, but nothing can read its raw bytes back out.
const DB_NAME = 'chatbro';
const STORE = 'keys';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const saveKey = (key) => run('readwrite', (s) => s.put(key, 'private'));
export const loadKey = () => run('readonly', (s) => s.get('private'));
export const clearKeys = () => run('readwrite', (s) => s.clear());
