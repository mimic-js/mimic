import { PrismaClient } from './generated/prisma/client.js';

const prisma = new PrismaClient();
console.log('client ready', typeof prisma.note.findMany);
