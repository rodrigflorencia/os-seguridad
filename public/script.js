/* ==========================================================================
   Zona de patrullaje – Malibu · script principal (módulo ES, sin frameworks)
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. CONFIGURACIÓN DE FIREBASE
   Copiá estos valores desde la consola de Firebase:
   Configuración del proyecto (⚙️) → General → "Tus apps" → app web →
   "Configuración del SDK" → opción "Config".
   Mientras queden los placeholders "TU_...", la página usa data/puntos.json.
   -------------------------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROYECTO",
  storageBucket: "TU_PROYECTO.appspot.com",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID",
};

/* --------------------------------------------------------------------------
   2. CONSTANTES
   -------------------------------------------------------------------------- */
const FIREBASE_VERSION = "10.14.1";
const FIRESTORE_TIMEOUT_MS = 5000;   // si Firestore no responde, se usa el JSON
const COLECCION = "puntos";
const RESPALDO_URL = "data/puntos.json";
const ASSETS_DIR = "assets/";
const SDK_DIR = `./vendor/firebase-${FIREBASE_VERSION}`; // SDK servido desde el propio hosting (npm run vendor)

/** Únicos dominios externos desde los que se aceptan imágenes (Firebase Storage). */
const HOSTS_IMAGENES = new Set(["firebasestorage.googleapis.com", "storage.googleapis.com"]);
const LARGO_MAX_NOMBRE = 80;

/** Recorridos disponibles (filtros). El color de cada uno está en style.css. */
const MODOS = {
  ciudad: {
    corto: "Ciudad",
    nombre: "Zona de patrullaje de áreas de la ciudad",
    descripcion: "Bar, teatro, estadio, casino, agencias, iglesia, comisaría, universidad y mercado de vehículos.",
  },
  trabajo: {
    corto: "Trabajo",
    nombre: "Zona de patrullaje de áreas de trabajo",
    descripcion: "Tala, minería, pesca, taxi, licencias, repartidor de dinero, mensajero, camión y mecánico.",
  },
  aks: {
    corto: "AK y guaridas",
    nombre: "Patrullaje de AK y guaridas",
    descripcion: "Los tres puntos de AK (torre, paseo y depósito), las guaridas y la zona de gemas.",
  },
};
const TEXTO_SIN_FILTRO = "Activa una o más zonas para ver sus lugares; toca un lugar para ver la foto del punto ciego.";

const params = new URLSearchParams(location.search);
const DEBUG = params.get("debug") === "1";

/* --------------------------------------------------------------------------
   3. REFERENCIAS AL DOM Y ESTADO
   -------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const els = {
  stage: $("#mapa"),
  canvas: $("#map-canvas"),
  zoomBtns: $$(".zoom-btn[data-zoom]"),
  hotspots: $("#hotspots"),
  botones: $$(".route-btn[data-modo]"),
  modoDesc: $("#modo-desc"),
  modal: $("#modal"),
  modalDialog: $(".modal__dialog"),
  modalTitle: $("#modal-title"),
  modalIcon: $("#modal-icon"),
  modalBody: $("#modal-body"),
  toast: $("#toast"),
  galleryTrack: $("#gallery-track"),
  galleryCount: $("#gallery-count"),
  galleryPrev: $("#gallery-prev"),
  galleryNext: $("#gallery-next"),
  inertZones: $$(".topbar, main, .footer, .skip-link"),
};

const state = {
  filtros: new Set(),  // recorridos activos; vacío = mapa limpio
  puntos: [],
  ultimoFoco: null,
};

/* --------------------------------------------------------------------------
   4. UTILIDADES
   -------------------------------------------------------------------------- */

/** ¿Es una ruta de imagen (y no un emoji)? */
const esImagen = (v) => /\.(png|webp|jpe?g|gif|avif)(\?.*)?$/i.test(v) || /^https:\/\//i.test(v);

/** Valida una ruta de imagen que viene de los datos (Firestore o puntos.json).
    Solo acepta: un archivo dentro de assets/ (sin "..", sin rutas absolutas ni otros protocolos)
    o una URL https de Firebase Storage. Cualquier otra cosa devuelve null. */
function rutaSegura(valor) {
  if (typeof valor !== "string") return null;
  const ruta = valor.trim();
  if (!ruta || ruta.length > 500) return null;
  if (/^https:\/\//i.test(ruta)) {
    try {
      const url = new URL(ruta);
      return url.protocol === "https:" && HOSTS_IMAGENES.has(url.hostname) ? url.href : null;
    } catch {
      return null;
    }
  }
  const relativa = ruta.startsWith(ASSETS_DIR) ? ruta.slice(ASSETS_DIR.length) : ruta;
  return /^[\w-]+(\/[\w-]+)*\.(png|webp|jpe?g|gif|avif)$/i.test(relativa) ? relativa : null;
}

/** Ícono: imagen validada, o un emoji/texto corto (se muestra con textContent). */
function iconoSeguro(valor) {
  if (typeof valor !== "string" || !valor.trim()) return null;
  if (esImagen(valor)) return rutaSegura(valor);
  const texto = valor.trim();
  return [...texto].length <= 8 ? texto : null;
}

/** Convierte una ruta ya validada en la URL a cargar. */
function resolverAsset(ruta) {
  if (!ruta) return null;
  return /^https:\/\//i.test(ruta) ? ruta : ASSETS_DIR + ruta;
}

/** ¿El firebaseConfig ya tiene valores reales? */
function firebaseConfigurado() {
  return Object.values(firebaseConfig).every((v) => v && !String(v).includes("TU_"));
}

/** Rechaza la promesa si tarda más de `ms`. */
function conTimeout(promesa, ms) {
  return Promise.race([
    promesa,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

const sinMovimiento = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Normaliza y valida un punto; devuelve null si no sirve.
    Un punto sin x/y (todavía sin ubicar) se conserva, pero no se dibuja en el mapa. */
function normalizarPunto(raw, id) {
  const coord = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  if (!raw || typeof raw !== "object") return null;
  const p = {
    id: String(raw.id ?? id ?? "").slice(0, 100),
    modo: raw.modo,
    nombre: String(raw.nombre ?? "Punto de patrullaje").slice(0, LARGO_MAX_NOMBRE),
    x: coord(raw.x),
    y: coord(raw.y),
    icono: iconoSeguro(raw.icono),
    imagen: rutaSegura(raw.imagen),
    orden: Number.isFinite(Number(raw.orden)) ? Number(raw.orden) : 0,
  };
  // Una ruta presente pero rechazada se avisa (el punto se conserva, sin esa imagen)
  if (raw.imagen && !p.imagen) console.warn("[puntos] Imagen no permitida, se ignora:", raw.imagen);
  if (raw.icono && !p.icono) console.warn("[puntos] Ícono no permitido, se ignora:", raw.icono);
  const enRango = (v) => v === null || (Number.isFinite(v) && v >= 0 && v <= 100);
  const valido = p.id && Object.hasOwn(MODOS, p.modo) && enRango(p.x) && enRango(p.y);
  if (!valido) console.warn("[puntos] Punto descartado por datos inválidos:", raw);
  return valido ? p : null;
}

const estaUbicado = (p) => Number.isFinite(p.x) && Number.isFinite(p.y);

/* --------------------------------------------------------------------------
   5. CARGA DE DATOS (Firestore → respaldo puntos.json)
   -------------------------------------------------------------------------- */

/** Lee la colección `puntos` ordenada por `orden`. El SDK (servido desde vendor/) se importa
    dinámicamente: si no carga, la página sigue funcionando con el JSON. */
async function cargarDesdeFirestore() {
  const [{ initializeApp }, { getFirestore, collection, query, orderBy, getDocs }] = await Promise.all([
    import(`${SDK_DIR}/firebase-app.js`),
    import(`${SDK_DIR}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const snap = await getDocs(query(collection(db, COLECCION), orderBy("orden")));
  return snap.docs.map((d) => normalizarPunto(d.data(), d.id)).filter(Boolean);
}

async function cargarRespaldo() {
  const res = await fetch(RESPALDO_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("puntos.json no es una lista");
  return data.map((p) => normalizarPunto(p)).filter(Boolean).sort((a, b) => a.orden - b.orden);
}

async function cargarPuntos() {
  if (firebaseConfigurado()) {
    try {
      const puntos = await conTimeout(cargarDesdeFirestore(), FIRESTORE_TIMEOUT_MS);
      if (puntos.length) return { puntos, fuente: "Firestore" };
      console.info("[puntos] Firestore está vacío; uso el respaldo local.");
    } catch (err) {
      console.warn("[puntos] No se pudo leer Firestore; uso el respaldo local.", err);
    }
  }
  try {
    return { puntos: await cargarRespaldo(), fuente: "puntos.json" };
  } catch (err) {
    console.error("[puntos] Tampoco se pudo leer puntos.json.", err);
    return { puntos: [], fuente: "sin datos" };
  }
}

/* --------------------------------------------------------------------------
   6. RENDER DE LOS PUNTOS
   -------------------------------------------------------------------------- */

/** Crea el ícono del punto: <img> PNG, o el emoji que venga en `icono` (📍 si no hay). */
function crearIcono(punto, claseImg = "", claseEmoji = "") {
  if (punto.icono && esImagen(punto.icono)) {
    const img = document.createElement("img");
    img.src = resolverAsset(punto.icono);
    img.alt = "";
    img.className = claseImg;
    img.decoding = "async";
    img.draggable = false;
    return img;
  }
  const span = document.createElement("span");
  span.className = claseEmoji;
  span.textContent = punto.icono || "📍";
  return span;
}

function renderHotspots() {
  const frag = document.createDocumentFragment();
  const visibles = state.puntos.filter((p) => state.filtros.has(p.modo) && estaUbicado(p));

  for (const p of visibles) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hotspot";
    btn.style.left = `${p.x}%`;
    btn.style.top = `${p.y}%`;
    btn.dataset.id = p.id;
    btn.dataset.modo = p.modo; // color del recorrido al que pertenece
    btn.setAttribute("aria-label", p.imagen ? `${p.nombre}: ver imagen de referencia` : p.nombre);

    // Ubicación del tooltip según la cercanía a los bordes
    if (p.y < 8) btn.classList.add("tip-below");
    if (p.x > 78) btn.classList.add("tip-left");
    else if (p.x < 22) btn.classList.add("tip-right");

    const tip = document.createElement("span");
    tip.className = "hotspot__tip";
    tip.setAttribute("aria-hidden", "true");
    tip.textContent = p.nombre;

    btn.append(crearIcono(p, "hotspot__icon", "hotspot__emoji"), tip);
    frag.append(btn);
  }
  els.hotspots.replaceChildren(frag);

  // Avisa en consola qué puntos faltan ubicar (sirve para calibrar con ?debug=1)
  const sinUbicar = state.puntos.filter((p) => state.filtros.has(p.modo) && !estaUbicado(p));
  if (sinUbicar.length) console.info("[puntos] Sin ubicar en el mapa:", sinUbicar.map((p) => p.id).join(", "));

  renderCarrusel();
}

/* --------------------------------------------------------------------------
   6 bis. CARRUSEL DE FOTOS (debajo del mapa)
   Muestra las fotos de los lugares visibles en el mapa; sin filtros activos, todas.
   Usa miniaturas de assets/thumbs/ y, si falta alguna, la foto completa.
   -------------------------------------------------------------------------- */
const ORDEN_MODOS = Object.keys(MODOS);

/** Miniatura de una imagen local (assets/thumbs/<archivo>); las URL completas se usan tal cual. */
function resolverMiniatura(ruta) {
  if (!ruta || /^https:\/\//i.test(ruta) || ruta.includes("/")) return resolverAsset(ruta);
  return `${ASSETS_DIR}thumbs/${ruta}`;
}

function renderCarrusel() {
  if (!els.galleryTrack) return;
  const conFoto = state.puntos
    .filter((p) => p.imagen && (!state.filtros.size || state.filtros.has(p.modo)))
    .sort((a, b) => ORDEN_MODOS.indexOf(a.modo) - ORDEN_MODOS.indexOf(b.modo) || a.orden - b.orden);

  const frag = document.createDocumentFragment();
  for (const p of conFoto) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gallery__item";
    btn.dataset.id = p.id;
    btn.dataset.modo = p.modo;
    btn.setAttribute("aria-label", `${p.nombre}: ver foto en grande`);

    const img = document.createElement("img");
    img.src = resolverMiniatura(p.imagen);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.width = 480;
    img.height = 270;
    img.addEventListener("error", () => { img.src = resolverAsset(p.imagen); }, { once: true });

    const cap = document.createElement("span");
    cap.className = "gallery__caption";
    const dot = Object.assign(document.createElement("span"), { className: "gallery__dot" });
    dot.setAttribute("aria-hidden", "true");
    cap.append(dot, document.createTextNode(p.nombre));

    btn.append(img, cap);
    li.append(btn);
    frag.append(li);
  }
  if (!conFoto.length && state.puntos.length) {
    const li = document.createElement("li");
    li.className = "gallery__empty";
    li.textContent = "No hay fotos para los recorridos elegidos.";
    frag.append(li);
  }
  els.galleryTrack.replaceChildren(frag);
  els.galleryTrack.scrollLeft = 0;
  els.galleryCount.textContent = conFoto.length ? `${conFoto.length} ${conFoto.length === 1 ? "foto" : "fotos"}` : "";
  actualizarFlechasCarrusel();
}

/** Desactiva ‹ › cuando no hay más fotos hacia ese lado. */
function actualizarFlechasCarrusel() {
  const t = els.galleryTrack;
  if (!t) return;
  els.galleryPrev.disabled = t.scrollLeft <= 2;
  els.galleryNext.disabled = t.scrollLeft + t.clientWidth >= t.scrollWidth - 2;
}

function moverCarrusel(direccion) {
  const t = els.galleryTrack;
  t.scrollBy({ left: direccion * t.clientWidth * 0.9, behavior: sinMovimiento() ? "auto" : "smooth" });
}

function iniciarCarrusel() {
  if (!els.galleryTrack) return;
  els.galleryPrev.addEventListener("click", () => moverCarrusel(-1));
  els.galleryNext.addEventListener("click", () => moverCarrusel(1));
  els.galleryTrack.addEventListener("scroll", actualizarFlechasCarrusel, { passive: true });
  new ResizeObserver(actualizarFlechasCarrusel).observe(els.galleryTrack);
  els.galleryTrack.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      moverCarrusel(e.key === "ArrowRight" ? 1 : -1);
    }
  });
  els.galleryTrack.addEventListener("click", (e) => {
    const btn = e.target.closest(".gallery__item");
    const punto = btn && state.puntos.find((p) => p.id === btn.dataset.id);
    if (punto) abrirModal(punto);
  });
}

/* --------------------------------------------------------------------------
   7. FILTROS DE RECORRIDO
   -------------------------------------------------------------------------- */

/** Prende o apaga un recorrido. */
function alternarFiltro(modo) {
  if (!MODOS[modo]) return;
  if (state.filtros.has(modo)) state.filtros.delete(modo);
  else state.filtros.add(modo);
  aplicarFiltros();
}

/** Sincroniza botones, texto de estado, puntos del mapa y URL con state.filtros. */
function aplicarFiltros({ animar = true } = {}) {
  cerrarModal();

  for (const btn of els.botones) {
    const activo = state.filtros.has(btn.dataset.modo);
    btn.classList.toggle("is-active", activo);
    btn.setAttribute("aria-pressed", String(activo));
  }

  actualizarEstado();

  // Fade de los puntos: salen, se re-dibujan y vuelven
  const rerender = () => {
    renderHotspots();
    els.hotspots.classList.remove("is-fading");
  };
  if (animar && !sinMovimiento()) {
    els.hotspots.classList.add("is-fading");
    setTimeout(rerender, 200);
  } else {
    rerender();
  }

  // Aviso para otros módulos (informe.js marca la zona recorrida según los filtros)
  document.dispatchEvent(new CustomEvent("filtros:cambio", { detail: [...state.filtros] }));

  // Enlace compartible: #ciudad,aks
  const hash = [...state.filtros].join(",");
  history.replaceState(null, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
}

/** Texto bajo los filtros: qué se está mostrando. */
function actualizarEstado() {
  if (!state.filtros.size) {
    els.modoDesc.textContent = TEXTO_SIN_FILTRO;
    return;
  }
  const activos = Object.keys(MODOS).filter((m) => state.filtros.has(m));
  const total = state.puntos.filter((p) => state.filtros.has(p.modo) && estaUbicado(p)).length;
  const nombres = activos.map((m) => MODOS[m].corto).join(" · ");
  els.modoDesc.textContent = state.puntos.length
    ? `Mostrando ${total} ${total === 1 ? "lugar" : "lugares"}: ${nombres}`
    : `Mostrando: ${nombres}`;
}

/** Lee los filtros desde la URL (#ciudad,trabajo). */
function filtrosDesdeHash() {
  return new Set(location.hash.slice(1).split(",").filter((m) => MODOS[m]));
}

/* --------------------------------------------------------------------------
   8. MODAL / LIGHTBOX (foco atrapado, Esc, clic fuera)
   -------------------------------------------------------------------------- */
function placeholder() {
  const div = document.createElement("div");
  div.className = "placeholder";
  const icon = document.createElement("span");
  icon.className = "placeholder__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "🖼️";
  const strong = document.createElement("strong");
  strong.textContent = "Imagen próximamente";
  const span = document.createElement("span");
  span.textContent = "Todavía no hay una imagen de referencia para este punto.";
  div.append(icon, strong, span);
  return div;
}

function abrirModal(punto) {
  state.ultimoFoco = document.activeElement;

  els.modalDialog.dataset.modo = punto.modo; // borde y título con el color del recorrido
  els.modalTitle.textContent = punto.nombre;
  els.modalIcon.replaceChildren(crearIcono(punto));

  const src = resolverAsset(punto.imagen);
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = `Imagen de referencia: ${punto.nombre}`;
    img.decoding = "async";
    img.addEventListener("error", () => els.modalBody.replaceChildren(placeholder()), { once: true });
    els.modalBody.replaceChildren(img);
  } else {
    els.modalBody.replaceChildren(placeholder());
  }

  els.modal.hidden = false;
  document.body.style.overflow = "hidden";
  els.inertZones.forEach((z) => (z.inert = true)); // el resto de la página no recibe foco
  $(".modal__close", els.modal).focus();
}

function cerrarModal() {
  if (els.modal.hidden) return;
  els.modal.hidden = true;
  els.modalBody.replaceChildren();
  document.body.style.overflow = "";
  els.inertZones.forEach((z) => (z.inert = false));
  state.ultimoFoco?.focus?.();
  state.ultimoFoco = null;
}

/** Mantiene el Tab dentro del diálogo (refuerzo por si el navegador no soporta `inert`). */
function atraparFoco(e) {
  const focusables = $$('button, [href], [tabindex]:not([tabindex="-1"])', els.modal).filter((el) => !el.disabled);
  if (!focusables.length) return;
  const primero = focusables[0];
  const ultimo = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === primero) {
    e.preventDefault();
    ultimo.focus();
  } else if (!e.shiftKey && document.activeElement === ultimo) {
    e.preventDefault();
    primero.focus();
  }
}

/* --------------------------------------------------------------------------
   9. TOAST
   -------------------------------------------------------------------------- */
let toastTimer;
function mostrarToast(texto, ms = 2600) {
  els.toast.textContent = texto;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

/* --------------------------------------------------------------------------
   10. MODO CALIBRACIÓN (?debug=1)
   Clic en el mapa → copia las coordenadas en % al portapapeles.
   En este modo, el clic con mouse sobre un punto también copia coordenadas;
   para abrir el popup usá el teclado (Tab + Enter).
   -------------------------------------------------------------------------- */
async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // Respaldo para contextos sin Clipboard API
    const ta = Object.assign(document.createElement("textarea"), { value: texto });
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function iniciarCalibracion() {
  document.documentElement.classList.add("is-debug");
  const dot = Object.assign(document.createElement("span"), { className: "debug-dot" });
  dot.hidden = true;
  els.canvas.append(dot);

  els.canvas.addEventListener("click", async (e) => {
    if (e.detail === 0) return; // activación por teclado: no calibrar
    e.preventDefault();
    e.stopPropagation();
    if (zoom.arrastro) return;  // fue un arrastre del mapa, no un clic
    // El rect del lienzo ya incluye el zoom, así que el % sale bien a cualquier escala
    const r = els.canvas.getBoundingClientRect();
    const x = +(((e.clientX - r.left) / r.width) * 100).toFixed(2);
    const y = +(((e.clientY - r.top) / r.height) * 100).toFixed(2);
    dot.style.left = `${x}%`;
    dot.style.top = `${y}%`;
    dot.hidden = false;
    const texto = `"x": ${x}, "y": ${y}`;
    const ok = await copiarTexto(texto);
    mostrarToast(ok ? `✅ Ubicación copiada · ${texto}` : `Ubicación: ${texto}`);
  }, true); // fase de captura: se adelanta al clic de los puntos

  console.info("[calibración] Activo. Haz clic en el mapa para copiar coordenadas en %.");
}

/* --------------------------------------------------------------------------
   10 bis. ZOOM Y DESPLAZAMIENTO DEL MAPA
   - Rueda del mouse / gesto del trackpad: zoom hacia el cursor.
   - Pellizco con dos dedos: zoom. Un dedo o el mouse: arrastrar (con zoom > 1).
   - Doble clic / doble toque: acercar ahí. Botones + / − / ⟲ (vista inicial).
   El lienzo se transforma con translate + scale; los puntos van adentro,
   así que siguen alineados con el mapa a cualquier escala.
   -------------------------------------------------------------------------- */
const zoom = {
  MIN: 1,          // se recalcula: el mapa siempre cubre el recuadro
  MAX: 3,          // se recalcula según el ancho (el mapa es de 581×1024: más allá se ve pixelado)
  PASO: 1.5,
  escala: 1,
  x: 0,            // traslación en px
  y: 0,
  punteros: new Map(),
  inicio: null,    // estado al empezar un gesto
  arrastro: false, // true si el último gesto movió el mapa (anula el clic)
  w: 0,            // tamaño del recuadro en la última aplicación (para reescalar al redimensionar)
  h: 0,
};

/** Vista con la que abre el mapa (y a la que vuelve ⟲): el recuadro marcado en assets/zoom.webp.
    Valores en % del mapa (581×1024): x 126–580, y 107–697. Se muestra centrado y lo más grande posible. */
const VISTA_INICIAL = { x1: 21.69, y1: 10.45, x2: 99.83, y2: 68.07 };

/** Aplica la transformación al lienzo y actualiza variables y botones. */
/* El lienzo mide lo mismo que el recuadro de ancho y conserva la proporción del mapa (581:1024).
   En celular el recuadro tiene esa misma proporción; en la computadora es apaisado, así que el mapa
   llena el ancho y se recorre arrastrando hacia arriba y abajo. */
const PROPORCION_MAPA = 1024 / 581;
const altoMapa = (w) => w * PROPORCION_MAPA;

/** ¿El mapa (con el zoom actual) es más grande que el recuadro? Entonces se puede arrastrar. */
const sePuedeMover = () =>
  zoom.escala > 1.001 || altoMapa(zoom.w) * zoom.escala > zoom.h + 1;

function aplicarZoom({ animar = false } = {}) {
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  // Si cambió el ancho del recuadro (resize, rotar el celular), la traslación se reescala con él
  if (zoom.w && w && w !== zoom.w) {
    zoom.x *= w / zoom.w;
    zoom.y *= w / zoom.w;
  }
  zoom.w = w;
  zoom.h = h;

  // Límites de zoom: mínimo = el mapa cubre el recuadro; máximo según cuánto se amplía la imagen
  const hm = altoMapa(w);
  zoom.MIN = Math.max(1, h / hm);
  zoom.MAX = Math.max(zoom.MIN * 1.5, Math.min(3, 1750 / Math.max(w, 1)));
  zoom.escala = Math.min(zoom.MAX, Math.max(zoom.MIN, zoom.escala));

  // Mantiene el mapa dentro del recuadro (sin bordes vacíos)
  zoom.x = Math.min(0, Math.max(w - w * zoom.escala, zoom.x));
  zoom.y = Math.min(0, Math.max(h - hm * zoom.escala, zoom.y));

  els.canvas.classList.toggle("is-animating", animar && !sinMovimiento());
  els.canvas.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.escala})`;
  els.stage.style.setProperty("--zoom", zoom.escala);
  // Íconos: tamaño parejo aunque el mapa sea más ancho (computadora) y crecen menos que el zoom
  const base = Math.min(1, 400 / Math.max(w, 1));
  els.stage.style.setProperty("--hs-scale", (base / Math.sqrt(zoom.escala)).toFixed(4));
  els.stage.classList.toggle("is-zoomed", sePuedeMover());

  for (const b of els.zoomBtns) {
    const t = b.dataset.zoom;
    b.disabled = (t === "in" && zoom.escala >= zoom.MAX) || (t === "out" && zoom.escala <= zoom.MIN);
  }
}

/** Cambia la escala manteniendo fijo el punto (cx, cy) del recuadro, en px. */
function zoomEn(nuevaEscala, cx, cy, opciones) {
  const s = Math.min(zoom.MAX, Math.max(zoom.MIN, nuevaEscala));
  zoom.x = cx - (cx - zoom.x) * (s / zoom.escala);
  zoom.y = cy - (cy - zoom.y) * (s / zoom.escala);
  zoom.escala = s;
  aplicarZoom(opciones);
}

const zoomAlCentro = (factor) =>
  zoomEn(zoom.escala * factor, els.stage.clientWidth / 2, els.stage.clientHeight / 2, { animar: true });

/** Encuadra VISTA_INICIAL: la escala más grande que la muestra entera, centrada en el recuadro. */
function irAVistaInicial({ animar = true } = {}) {
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  const hm = altoMapa(w);
  zoom.w = w;
  zoom.h = h;
  zoom.MIN = Math.max(1, h / hm);
  const v = VISTA_INICIAL;
  const ancho = (v.x2 - v.x1) / 100;
  const alto = (v.y2 - v.y1) / 100;
  // La mayor escala que muestra el área entera; nunca menos que la que cubre el recuadro
  zoom.escala = Math.min(zoom.MAX, Math.max(zoom.MIN, Math.min(1 / ancho, h / (alto * hm))));
  const cx = ((v.x1 + v.x2) / 200) * w;  // centro del área, en px del mapa sin zoom
  const cy = ((v.y1 + v.y2) / 200) * hm;
  zoom.x = w / 2 - cx * zoom.escala;
  zoom.y = h / 2 - cy * zoom.escala;
  aplicarZoom({ animar }); // aplicarZoom ajusta si el área toca un borde del mapa
}

const resetZoom = () => irAVistaInicial();

/** Posición de un evento relativa al recuadro del mapa. */
function puntoLocal(e) {
  const r = els.stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function guardarInicioGesto() {
  const [a, b = a] = [...zoom.punteros.values()];
  zoom.inicio = {
    escala: zoom.escala,
    x: zoom.x,
    y: zoom.y,
    medio: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
  };
}

/** Marca el gesto como arrastre y captura el puntero (recién ahora, para no robar clics a los puntos). */
function marcarArrastre(e) {
  if (!zoom.arrastro) {
    zoom.arrastro = true;
    els.stage.classList.add("is-dragging");
  }
  if (!els.stage.hasPointerCapture(e.pointerId)) els.stage.setPointerCapture(e.pointerId);
}

function iniciarZoom() {
  // Botones
  for (const b of els.zoomBtns) {
    b.addEventListener("click", () => {
      if (b.dataset.zoom === "in") zoomAlCentro(zoom.PASO);
      else if (b.dataset.zoom === "out") zoomAlCentro(1 / zoom.PASO);
      else resetZoom();
    });
  }

  // Rueda: acerca/aleja hacia el cursor. Sin zoom y alejando, deja que la página haga scroll.
  els.stage.addEventListener("wheel", (e) => {
    if (e.deltaY > 0 && zoom.escala <= zoom.MIN) return;
    e.preventDefault();
    const p = puntoLocal(e);
    // ctrlKey = pellizco en trackpad: deltas chicos y continuos
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
    zoomEn(zoom.escala * factor, p.x, p.y);
  }, { passive: false });

  // Doble clic: acerca ahí (o vuelve a la vista inicial si ya está al máximo)
  els.stage.addEventListener("dblclick", (e) => {
    if (e.target.closest(".hotspot, .zoom-controls")) return;
    const p = puntoLocal(e);
    if (zoom.escala >= zoom.MAX) resetZoom();
    else zoomEn(zoom.escala * 2, p.x, p.y, { animar: true });
  });

  // Arrastre y pellizco con Pointer Events
  els.stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".zoom-controls")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    zoom.punteros.set(e.pointerId, puntoLocal(e));
    zoom.arrastro = false;
    guardarInicioGesto();
  });

  els.stage.addEventListener("pointermove", (e) => {
    if (!zoom.punteros.has(e.pointerId)) return;
    zoom.punteros.set(e.pointerId, puntoLocal(e));
    const pts = [...zoom.punteros.values()];
    const ini = zoom.inicio;

    if (pts.length >= 2) {
      // Pellizco: escala según la distancia entre dedos, centrada en su punto medio
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const medio = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = Math.min(zoom.MAX, Math.max(zoom.MIN, ini.escala * (dist / ini.dist)));
      zoom.x = medio.x - (ini.medio.x - ini.x) * (s / ini.escala);
      zoom.y = medio.y - (ini.medio.y - ini.y) * (s / ini.escala);
      zoom.escala = s;
      marcarArrastre(e);
      aplicarZoom();
    } else if (sePuedeMover()) {
      // Arrastre con un puntero
      const dx = pts[0].x - ini.medio.x;
      const dy = pts[0].y - ini.medio.y;
      if (!zoom.arrastro && Math.hypot(dx, dy) < 5) return; // umbral: un toque no es arrastre
      zoom.x = ini.x + dx;
      zoom.y = ini.y + dy;
      marcarArrastre(e);
      aplicarZoom();
    }
  });

  const soltar = (e) => {
    if (!zoom.punteros.delete(e.pointerId)) return;
    if (zoom.punteros.size) guardarInicioGesto(); // queda un dedo: sigue arrastrando desde ahí
    else els.stage.classList.remove("is-dragging");
  };
  els.stage.addEventListener("pointerup", soltar);
  els.stage.addEventListener("pointercancel", soltar);

  // Si hubo arrastre, el clic que llega al soltar no abre ningún punto
  els.stage.addEventListener("click", (e) => {
    if (zoom.arrastro) {
      e.stopPropagation();
      e.preventDefault();
      zoom.arrastro = false;
    }
  }, true);

  // Al cambiar el tamaño de la ventana, el mapa se reacomoda dentro del recuadro
  new ResizeObserver(() => aplicarZoom()).observe(els.stage);
  irAVistaInicial({ animar: false });
}

/* --------------------------------------------------------------------------
   11. EVENTOS
   -------------------------------------------------------------------------- */
/** Menú "Recursos" de la barra superior: abre con clic, cierra con clic afuera, Esc o al elegir un enlace. */
function iniciarMenuRecursos() {
  const btn = $("#menu-recursos-btn");
  const lista = $("#menu-recursos");
  if (!btn || !lista) return;

  const abrir = (si) => {
    lista.hidden = !si;
    btn.setAttribute("aria-expanded", String(si));
  };
  btn.addEventListener("click", () => abrir(lista.hidden));
  lista.addEventListener("click", (e) => { if (e.target.closest("a")) abrir(false); });
  document.addEventListener("click", (e) => {
    if (!lista.hidden && !e.target.closest(".menu")) abrir(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lista.hidden) {
      abrir(false);
      btn.focus();
    }
  });
}

function enlazarEventos() {
  iniciarMenuRecursos();
  iniciarCarrusel();
  // Filtros: cada botón prende o apaga su recorrido
  for (const btn of els.botones) {
    btn.addEventListener("click", () => alternarFiltro(btn.dataset.modo));
  }

  // Clic en un punto (delegado)
  els.hotspots.addEventListener("click", (e) => {
    const btn = e.target.closest(".hotspot");
    if (!btn) return;
    const punto = state.puntos.find((p) => p.id === btn.dataset.id);
    if (!punto) return;
    // Solo se abre la ventana si el lugar tiene imagen
    if (punto.imagen) abrirModal(punto);
    else mostrarToast(`${punto.nombre}: todavía no tiene imagen.`);
  });

  // Modal: ✕ y clic fuera
  els.modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) cerrarModal();
  });

  // Teclado global: Esc y trampa de foco
  document.addEventListener("keydown", (e) => {
    if (els.modal.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cerrarModal();
    } else if (e.key === "Tab") {
      atraparFoco(e);
    }
  });

  // Enlaces directos: #ciudad, #trabajo, #aks (o combinados: #ciudad,aks)
  // Solo se tienen en cuenta hashes de filtros: un ancla como #informe no apaga el mapa.
  window.addEventListener("hashchange", () => {
    const partes = location.hash.slice(1).split(",").filter(Boolean);
    if (partes.length && !partes.every((m) => MODOS[m])) return;
    state.filtros = filtrosDesdeHash();
    aplicarFiltros();
  });
}

/** Las secciones de abajo aparecen suavemente al llegar a ellas con el scroll. */
function iniciarAparicion() {
  if (!("IntersectionObserver" in window)) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const obs = new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("is-visible");
      obs.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  for (const el of $$(".gallery, .tips-section, .footer")) {
    el.classList.add("reveal");
    obs.observe(el);
  }
}

/* --------------------------------------------------------------------------
   12. INICIO
   -------------------------------------------------------------------------- */
async function init() {
  // Imágenes con respaldo (p. ej. la foto del Dr. Jordan): si no cargan, se ocultan y quedan las iniciales
  for (const img of $$("img[data-fallback]")) {
    const romper = () => img.classList.add("is-broken");
    if (img.complete && !img.naturalWidth) romper();
    else img.addEventListener("error", romper, { once: true });
  }

  enlazarEventos();
  iniciarZoom();
  iniciarAparicion();
  if (DEBUG) iniciarCalibracion();

  // Arranca con el mapa limpio (o con los recorridos del enlace, p. ej. #ciudad,aks)
  state.filtros = filtrosDesdeHash();
  aplicarFiltros({ animar: false });

  const { puntos, fuente } = await cargarPuntos();
  state.puntos = puntos;
  console.info(`[puntos] ${puntos.length} puntos cargados desde ${fuente}.`);
  renderHotspots();
  actualizarEstado();
}

init();
