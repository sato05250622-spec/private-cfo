// favicon.ico (multi-resolution 16/32/48) を生成する。
// sips は .ico 出力非対応のため、to-ico (純 Node) を使用。
//
// 入力:
//   public/favicon-16x16.png     (sips で生成済み)
//   public/favicon-32x32.png     (sips で生成済み)
//   /tmp/icon-48.png             (sips で一時生成、ico 内格納のみ、public/ には公開しない)
//
// 出力:
//   public/favicon.ico
//
// 後日ロゴ更新時の再実行手順:
//   1. sips で /tmp/logo-master.png から 16/32/48 PNG を生成
//   2. cp /tmp/...png public/favicon-{16,32}x.png
//   3. node scripts/build-favicon-ico.cjs

const toIco = require('to-ico');
const fs = require('fs');
const path = require('path');

const pub = (rel) => path.join(__dirname, '..', 'public', rel);
const tmp48 = '/tmp/icon-48.png';

if (!fs.existsSync(tmp48)) {
  console.error('[build-favicon-ico] missing', tmp48);
  console.error('  → 先に: sips -z 48 48 /tmp/logo-master.png --out /tmp/icon-48.png');
  process.exit(1);
}

const buffers = [
  fs.readFileSync(pub('favicon-16x16.png')),
  fs.readFileSync(pub('favicon-32x32.png')),
  fs.readFileSync(tmp48),
];

toIco(buffers).then((buf) => {
  fs.writeFileSync(pub('favicon.ico'), buf);
  console.log('[build-favicon-ico] generated public/favicon.ico, size:', buf.length, 'bytes');
}).catch((e) => {
  console.error('[build-favicon-ico] failed', e);
  process.exit(1);
});
