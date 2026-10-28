import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

async function testConnection() {
  console.log('Starting MySQL connection test...');
  try {
    const envPath = path.resolve(process.cwd(), 'mysql.env');
    if (!fs.existsSync(envPath)) {
      throw new Error('mysql.env not found');
    }
    const envContent = fs.readFileSync(envPath, 'utf8');
    const env = {};
    const lines = envContent.split(/\r?\n/);
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;
      const separatorIndex = trimmedLine.indexOf('=');
      if (separatorIndex === -1) continue;
      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim();
      env[key] = value;
    }
    const config = {
      host: env.url,
      port: parseInt(env.port, 10),
      user: env.username,
      password: env.password,
      database: env.db_name,
    };
    console.log('Attempting to connect...');
    const connection = await mysql.createConnection(config);
    console.log('✅ Connection successful!');
    const [rows] = await connection.execute('SELECT 1 + 1 AS result');
    console.log('Query test (1+1=?):', rows[0].result);
    await connection.end();
    console.log('Connection closed.');
  } catch (err) {
    console.error('❌ Connection failed!');
    console.error('Error details:', err.message);
    process.exit(1);
  }
}
testConnection();
