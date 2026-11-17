import ui from './ui/es.js';
import server from './server/es.js';
import night from './night/es.js';

export default { ...ui, ...server, ...night,

  "language.label": "Idioma",
  "app.title": "Yexi · Mesa de póquer",
  "app.name": "Yexi",
  "app.description": "Yexi: póquer con amigos en tu red local, con cartas físicas o digitales y fichas de juego.",
  "manifest.name": "Yexi · Póquer con amigos",
  "manifest.description": "Póquer con amigos en tu red local. Cartas físicas o digitales, solo fichas de juego.",
  "app.loading": "Volviendo a la mesa.",
  "app.noscript": "Activa JavaScript para sincronizar la mesa y jugar.",
  "run.1": "Jugar una vez",
  "run.2": "Jugar dos veces",
  "run.3": "Jugar tres veces"
};
