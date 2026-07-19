import { InMemoryStorage } from '../../src/infrastructure/in-memory/in-memory-storage.js';
import { describeStorageContract } from './storage-contract.js';

describeStorageContract({
  name: 'InMemoryStorage',
  createStorage: () => {
    const storage = new InMemoryStorage();
    return Promise.resolve({ stores: storage, items: storage });
  },
});
