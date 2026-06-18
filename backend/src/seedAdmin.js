// Cria (ou atualiza) o usuário administrador inicial.
// Uso: node src/seedAdmin.js "Nome Admin" admin@exemplo.com SenhaForte123

const bcrypt = require('bcryptjs');
const db = require('./db');

const [, , nome, email, senha] = process.argv;

if (!nome || !email || !senha) {
  console.error('Uso: node src/seedAdmin.js "Nome" email@exemplo.com senha');
  process.exit(1);
}

const senhaHash = bcrypt.hashSync(senha, 10);

const existente = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);

if (existente) {
  db.prepare('UPDATE usuarios SET nome = ?, senha_hash = ?, perfil = ?, ativo = 1 WHERE email = ?')
    .run(nome, senhaHash, 'admin', email);
  console.log(`Usuário admin atualizado: ${email}`);
} else {
  db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)')
    .run(nome, email, senhaHash, 'admin');
  console.log(`Usuário admin criado: ${email}`);
}
