// Conexão única e cacheada com o MongoDB.
// Padrão serverless-safe: reaproveita o client entre invocações (não reconecta a cada request).
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGO_DB || 'memphis_pdv';

let clientPromise = global.__mongoClientPromise;

function getClientPromise() {
  if (!uri) throw new Error('MONGODB_URI não definido (.env)');
  if (!clientPromise) {
    const client = new MongoClient(uri, { maxPoolSize: 10 });
    clientPromise = client.connect();
    global.__mongoClientPromise = clientPromise; // sobrevive a hot-reloads/invocações
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClientPromise();
  return client.db(DB_NAME);
}

module.exports = { getDb, DB_NAME };
