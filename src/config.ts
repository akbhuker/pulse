/** Env-driven configuration. */
export const config = {
  // directConnection=true connects straight to the node on this port without
  // discovering (or name-matching) the replica set, so it works with ANY local
  // single-node replica set — Docker's `rs0` or an existing mongod. Change
  // streams still work because the node is a replica-set member. For Atlas, set
  // MONGODB_URI to the mongodb+srv string (which manages its own topology).
  mongoUrl: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?directConnection=true',
  dbName: process.env.MONGO_DB ?? 'pulse',
  port: Number(process.env.PORT ?? 4000),
  /** Collection holding raw events. */
  collection: 'events',
};
