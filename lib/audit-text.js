'use strict';
const LABELS = {
  'login.admin.ok': 'Connexion du patron',
  'login.admin.fail': 'Échec de connexion patron',
  'login.staff.ok': 'Connexion employé',
  'login.staff.fail': 'Échec de connexion employé',
  'employee.created': 'Employé créé',
  'employee.updated': 'Employé modifié',
  'employee.deleted': 'Employé supprimé',
  'product.created': 'Fiche créée',
  'product.updated': 'Fiche modifiée',
  'product.duplicated': 'Fiche dupliquée',
  'product.deleted': 'Fiche supprimée définitivement',
  'stock.changed': 'Stock modifié',
  'order.fulfillment': 'Statut de commande modifié',
  'settings.updated': 'Réglages modifiés',
  'password.reset': 'Mot de passe réinitialisé'
};

function describe(event, d = {}) {
  const base = LABELS[event] || event;
  const name = d.name ? ` « ${d.name} »` : '';
  if (event === 'order.fulfillment') return `${base} : commande n°${d.orderId} → ${d.status}`;
  if (event === 'stock.changed') return `${base}${name} (${(d.changes || []).length} variante(s))`;
  return `${base}${name}`;
}

module.exports = { describe };
