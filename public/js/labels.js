/* Étiquettes d'adresse à imprimer (planche A4, 2 colonnes × 4 lignes = 8 étiquettes de 99 × 67 mm,
   le format des planches autocollantes courantes type Avery L7165). Utilisé par l'admin et l'espace équipe.
   Utilisation : AubeLabels.print(commandes, { name, address }) */
(function () {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const COUNTRIES = { FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', DE: 'Allemagne', ES: 'Espagne', IT: 'Italie', PT: 'Portugal', NL: 'Pays-Bas', GB: 'Royaume-Uni', MC: 'Monaco', CA: 'Canada', US: 'États-Unis' };

  const CSS = `
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111; }
    .sheet { width: 210mm; height: 297mm; padding: 13mm 5mm 0; display: grid; grid-template-columns: repeat(2, 99.1mm); grid-auto-rows: 67.7mm; column-gap: 2.5mm; page-break-after: always; break-after: page; }
    .sheet:last-child { page-break-after: auto; break-after: auto; }
    .label { padding: 6mm 8mm; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; }
    .from { font-size: 8pt; line-height: 1.3; color: #444; }
    .to { font-size: 13pt; line-height: 1.35; margin-left: 6mm; }
    .to strong { font-size: 14pt; }
    .num { font-size: 8pt; color: #444; text-align: right; }
    .guide { display: none; }
    .toolbar { position: fixed; top: 0; left: 0; right: 0; background: #fff3; padding: 6px; text-align: center; font: 13px Arial; }
    @media screen {
      body { background: #ddd; }
      .sheet { background: #fff; margin: 10mm auto; box-shadow: 0 0 6px #0004; }
      .label { outline: 1px dashed #ccc; }
      .toolbar { background: #fffe; border-bottom: 1px solid #ccc; }
      .spacer { height: 14mm; }
    }
    @media print { .toolbar, .spacer { display: none; } }
  `;

  function labelHtml(o, sender) {
    const c = o.customer || {};
    const name = c.name || o.payerName || '';
    const country = c.country ? (COUNTRIES[String(c.country).toUpperCase()] || c.country) : '';
    const cityLine = [c.postalCode, c.city].filter(Boolean).join(' ');
    const to = [c.address, cityLine, country && country !== 'France' ? country.toUpperCase() : ''].filter(Boolean).map(esc).join('<br>');
    const from = [sender && sender.name, sender && sender.address].filter(Boolean).map(esc).join('<br>');
    return `<div class="label">
      <div class="from">${from}</div>
      <div class="to"><strong>${esc(name)}</strong><br>${to || '<em>Adresse manquante</em>'}</div>
      <div class="num">Commande n°${esc(o.id)}</div>
    </div>`;
  }

  // startAt : nombre d'étiquettes déjà utilisées sur la première planche (0 à 7), pour réutiliser une planche entamée
  function print(orders, sender, startAt) {
    const list = (orders || []).filter(Boolean);
    if (!list.length) return false;
    const skip = Math.max(0, Math.min(7, parseInt(startAt, 10) || 0));
    const cells = Array(skip).fill('<div class="label"></div>').concat(list.map(o => labelHtml(o, sender)));
    const sheets = [];
    for (let i = 0; i < cells.length; i += 8) sheets.push(`<div class="sheet">${cells.slice(i, i + 8).join('')}</div>`);
    const w = window.open('', '_blank');
    if (!w) { alert("Le navigateur a bloqué la fenêtre d'impression. Autorise les fenêtres pop-up pour ce site."); return false; }
    w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Étiquettes d'adresse</title><style>${CSS}</style></head><body>
      <div class="toolbar">Étiquettes d'adresse — imprime en <strong>taille réelle (100 %)</strong>, sans marges, sur du papier A4.</div><div class="spacer"></div>
      ${sheets.join('')}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (e) { /* l'utilisatrice peut imprimer à la main */ } }, 400);
    return true;
  }

  // Coordonnées de l'expéditeur : celles saisies dans la configuration légale du site
  let senderPromise = null;
  function loadSender() {
    if (!senderPromise) {
      senderPromise = fetch('/api/config').then(r => r.json()).then(cfg => {
        const l = (cfg && cfg.legal) || {};
        return { name: l.name || 'Aube', address: l.address || '' };
      }).catch(() => ({ name: 'Aube', address: '' }));
    }
    return senderPromise;
  }

  window.AubeLabels = { print, loadSender };
})();
