'use strict';
/** Console — activité de connexion des espaces et signaux à examiner (lecture seule). */
const loginActivity = require('../../login-activity');

module.exports = function (api) {
  api.get('/login-activity', (req, res) => {
    const q = req.query;
    res.json({
      rows: loginActivity.list({ cabinetId: q.cabinet || null, userId: q.user || null, resultat: q.resultat || null, depuisHeures: q.heures || null, limit: q.limit }),
      compteurs24h: loginActivity.counts24h(q.cabinet || null),
      signaux: loginActivity.signals({ cabinetId: q.cabinet || null }),
      geoip: require('../../geoip').configured(),
    });
  });
};
