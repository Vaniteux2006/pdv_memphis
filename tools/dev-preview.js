// sobe o servidor local no banco de TESTE (pra preview/desenvolvimento, nunca produção)
process.env.MONGO_DB = 'memphis_pdv_test';
process.env.NODE_ENV = 'development';
const PORT = Number(process.env.PORT) || 3000; // env chega como string; o listen coage, o tipo não
// server.js só dá listen quando é o módulo principal; aqui a gente importa o app e sobe na mão
const app = require('../server.js');
app.listen(PORT, '127.0.0.1', () => console.log(`\n  Memphis PDV (banco de TESTE) em 127.0.0.1:${PORT}\n`));
