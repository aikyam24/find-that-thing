let connection;

export function openDatabase() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('find-that-thing', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages', { keyPath: 'id' });
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = null; };
      resolve(request.result);
    };
    request.onerror = () => { connection = null; reject(request.error); };
    request.onblocked = () => { connection = null; reject(new Error('Close other Find That Thing windows and try again.')); };
  });
  return connection;
}

export async function snapshot() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pages', 'meta'], 'readonly');
    const pages = tx.objectStore('pages').getAll();
    const revision = tx.objectStore('meta').get('revision');
    const generation = tx.objectStore('meta').get('deletionGeneration');
    tx.oncomplete = () => resolve({ pages: pages.result, revision: revision.result || 0, generation: generation.result || 0 });
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Could not read saved pages.'));
  });
}

async function mutate(operation, { deletion = false, expectedGeneration } = {}) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pages', 'meta'], 'readwrite');
    const pages = tx.objectStore('pages');
    const meta = tx.objectStore('meta');
    let outdated = false;
    const generation = meta.get('deletionGeneration');
    generation.onsuccess = () => {
      const current = generation.result || 0;
      if (expectedGeneration !== undefined && current !== expectedGeneration) {
        outdated = true; tx.abort(); return;
      }
      operation(pages);
      const revision = meta.get('revision');
      revision.onsuccess = () => meta.put((revision.result || 0) + 1, 'revision');
      if (deletion) meta.put(current + 1, 'deletionGeneration');
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error(outdated ? 'The collection changed while saving. Save the page again.' : 'Could not update your saved pages.'));
  });
}

export function saveRecord(record, expectedGeneration) {
  return mutate(pages => {
    const previous = pages.get(record.id);
    previous.onsuccess = () => pages.put({ ...record, createdAt: previous.result?.createdAt ?? record.createdAt });
  }, { expectedGeneration });
}

export function forgetRecord(id) { return mutate(pages => pages.delete(id), { deletion: true }); }
export function clearRecords() { return mutate(pages => pages.clear(), { deletion: true }); }
