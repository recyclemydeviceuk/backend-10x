import mongoose from 'mongoose';
import { env } from '../config/env';

export async function connectDb(uri = env.mongoUri): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  const conn = await mongoose.connect(uri, { dbName: env.mongoDb });
  console.log(`[db] connected to ${conn.connection.host}/${conn.connection.name}`);
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
