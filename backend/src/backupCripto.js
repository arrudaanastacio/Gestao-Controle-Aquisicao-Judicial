// =====================================================================
// backupCripto.js — Criptografia dos backups (Onda C / em repouso).
//
// Cifra o backup com AES-256-GCM (autenticado: detecta adulteração), em
// STREAMING (memória constante — o backup tem centenas de MB), combinando
// compressão gzip + cifra num só passo. A chave de 32 bytes é derivada por
// scrypt a partir da senha em BACKUP_CHAVE (backend/.env) + um salt aleatório
// por arquivo. NUNCA guardamos a chave junto do backup.
//
// Formato do arquivo (.db.gz.enc):
//   [MAGIC "CJB1" (4)] [versao (1)] [salt (16)] [iv (12)] [gzip+cifra...] [authTag (16)]
//
// IMPORTANTE: se a senha (BACKUP_CHAVE) for perdida, os backups cifrados ficam
// IRRECUPERÁVEIS. Guarde uma cópia da senha em local seguro e SEPARADO da
// máquina (ex.: gerenciador de senhas).
// =====================================================================
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('CJB1');
const VERSAO = 1;
const TAM_SALT = 16;
const TAM_IV = 12;
const TAM_TAG = 16;
const TAM_CABECALHO = MAGIC.length + 1 + TAM_SALT + TAM_IV; // 4+1+16+12 = 33

function chaveBackup() {
  const s = process.env.BACKUP_CHAVE;
  return s && String(s).trim() ? String(s) : null;
}

// Comprime (gzip) E cifra (AES-256-GCM) `origem` -> `destino`, em streaming.
function comprimirECifrar(origem, destino, senha) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(TAM_SALT);
    const iv = crypto.randomBytes(TAM_IV);
    const key = crypto.scryptSync(String(senha), salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const gz = zlib.createGzip({ level: 6 });
    const inp = fs.createReadStream(origem);
    const out = fs.createWriteStream(destino);
    let erro = null;
    const falhar = (e) => { if (!erro) { erro = e; try { out.destroy(); } catch (_) {} reject(e); } };
    inp.on('error', falhar); gz.on('error', falhar); cipher.on('error', falhar); out.on('error', falhar);

    // Cabeçalho (em claro: não é segredo — o segredo é a senha).
    out.write(Buffer.concat([MAGIC, Buffer.from([VERSAO]), salt, iv]));
    // Quando a cifra terminar, anexa o authTag (16 bytes) e fecha.
    cipher.on('end', () => { try { out.write(cipher.getAuthTag()); out.end(); } catch (e) { falhar(e); } });
    out.on('finish', () => { if (!erro) resolve(destino); });

    inp.pipe(gz).pipe(cipher).pipe(out, { end: false });
  });
}

// Descriptografa + descomprime `origem` (.db.gz.enc) -> `destino` (.db).
function decifrarEDescomprimir(origem, destino, senha) {
  return new Promise((resolve, reject) => {
    let fd = null;
    try {
      const tam = fs.statSync(origem).size;
      if (tam < TAM_CABECALHO + TAM_TAG) throw new Error('Arquivo cifrado muito pequeno/corrompido.');
      const cab = Buffer.alloc(TAM_CABECALHO);
      fd = fs.openSync(origem, 'r');
      fs.readSync(fd, cab, 0, TAM_CABECALHO, 0);
      if (!cab.subarray(0, 4).equals(MAGIC)) throw new Error('Arquivo não é um backup cifrado (CJB1) válido.');
      const salt = cab.subarray(5, 5 + TAM_SALT);
      const iv = cab.subarray(5 + TAM_SALT, 5 + TAM_SALT + TAM_IV);
      const authTag = Buffer.alloc(TAM_TAG);
      fs.readSync(fd, authTag, 0, TAM_TAG, tam - TAM_TAG);
      fs.closeSync(fd); fd = null;

      const key = crypto.scryptSync(String(senha), salt, 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const gunzip = zlib.createGunzip();
      // Lê só o miolo (ciphertext), sem o cabeçalho nem o authTag final.
      const inp = fs.createReadStream(origem, { start: TAM_CABECALHO, end: tam - TAM_TAG - 1 });
      const out = fs.createWriteStream(destino);
      const falhar = (e) => reject(e);
      inp.on('error', falhar);
      decipher.on('error', (e) => falhar(new Error('Falha ao descriptografar (senha errada ou arquivo adulterado): ' + e.message)));
      gunzip.on('error', falhar); out.on('error', falhar);
      out.on('finish', () => resolve(destino));
      inp.pipe(decipher).pipe(gunzip).pipe(out);
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      reject(e);
    }
  });
}

function pareceCifrado(nome) { return /\.enc$/i.test(nome); }

module.exports = { chaveBackup, comprimirECifrar, decifrarEDescomprimir, pareceCifrado };
