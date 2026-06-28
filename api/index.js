// Entrypoint serverless da Vercel.
// Reaproveita o app Express inteiro (server.js exporta o app; o middleware "ready"
// inicializa o Mongo sob demanda). Toda requisição é encaminhada pra cá via vercel.json.
module.exports = require('../server.js');
