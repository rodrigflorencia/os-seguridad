# Zona de patrullaje – Malibu

Mapa interactivo del **Área de Seguridad de Servicios Médicos Malibu Latam** (OneState Roleplay).
HTML + CSS + JavaScript vanilla (módulos ES), publicado en **Firebase Hosting**, con los puntos en **Firestore**.

La página arranca con el mapa limpio. Hay tres recorridos, cada uno con el color de su banner:

| Recorrido | `modo` | Color |
| --- | --- | --- |
| Áreas de la ciudad | `ciudad` | amarillo |
| Áreas de trabajo | `trabajo` | violeta |
| AK y guaridas | `aks` | naranja |

Los tres botones, arriba del mapa, son filtros que se pueden combinar: cada uno muestra u oculta los lugares de su recorrido, marcados con su ícono resaltado en su color. Al tocar un lugar se abre su imagen, si tiene una. También se puede enlazar directo a una combinación, por ejemplo `#ciudad` o `#ciudad,aks`.

```text
public/
  index.html · style.css · script.js
  data/puntos.json        ← respaldo local (misma estructura que Firestore)
  assets/                 ← mapas, íconos PNG e imágenes de los popups
scripts/seed.mjs          ← sube puntos.json a Firestore
firebase.json · .firebaserc · firestore.rules
```

## 1. Configurar `firebaseConfig`

1. En la [consola de Firebase](https://console.firebase.google.com/), abre tu proyecto → ⚙️ **Configuración del proyecto** → **General**.
2. En **Tus apps**, crea (o elige) una **app web** y, en **Configuración del SDK**, selecciona **Config**.
3. Copia los valores en el bloque `firebaseConfig` al inicio de [public/script.js](public/script.js).
4. Pon el ID del proyecto en [.firebaserc](.firebaserc) (reemplaza `TU_PROYECTO`).
5. En [firestore.rules](firestore.rules), reemplaza `ADMIN_EMAIL@ejemplo.com` por el email del administrador.
6. En la consola, crea la base de **Firestore** (modo producción).

Mientras `firebaseConfig` tenga placeholders `TU_...`, la página usa `data/puntos.json`. Si Firestore falla, tarda más de 5 s o está vacío, también usa el JSON. La consola del navegador indica de dónde se cargaron los puntos.

## 2. Correr el seed

Necesitas una clave de cuenta de servicio: consola → ⚙️ → **Cuentas de servicio** → **Generar nueva clave privada**. Guárdala como `serviceAccountKey.json` en la raíz (está en `.gitignore`, **no la subas**). También puedes indicar la ruta con la variable `GOOGLE_APPLICATION_CREDENTIALS`.

```bash
npm install
npm run seed              # crea o actualiza los documentos (idempotente: el ID del documento es el `id` del punto)
npm run seed -- --prune   # además borra de Firestore los puntos que ya no estén en el JSON
```

## Headers de seguridad

[firebase.json](firebase.json) agrega a todas las respuestas:

| Header | Para qué |
| --- | --- |
| `Content-Security-Policy` | Solo se ejecutan scripts propios; estilos y fuentes de Google Fonts; conexiones solo a Firestore; imágenes propias o de Firebase Storage. |
| `X-Frame-Options: DENY` y `frame-ancestors 'none'` | Ninguna otra web puede mostrar la página dentro de un iframe. |
| `X-Content-Type-Options: nosniff` | El navegador no "adivina" tipos de archivo. |
| `Referrer-Policy: strict-origin` | Al salir hacia otro sitio solo se envía el dominio, nunca la ruta ni los filtros. |
| `Permissions-Policy` | Desactiva cámara, micrófono, ubicación, pagos y USB. |
| `Cross-Origin-Opener-Policy`, `Strict-Transport-Security` | Aislamiento de ventanas y HTTPS obligatorio. |
| `X-Robots-Tag: noindex…` (y la `<meta name="robots">`) | Los buscadores no indexan la página ni sus imágenes. |

> Si agregas algo de otro dominio (un script, una fuente, imágenes de otro sitio, un widget), agrégalo a la directiva que corresponda de la CSP; si no, el navegador lo bloquea y lo avisa en la consola.

No hay `robots.txt` con `Disallow` a propósito: si se bloquea el rastreo, Google no llega a leer el `noindex` y podría listar la URL igual.

## Protecciones de Firebase y del código

**Ya incluidas:**

- **SDK de Firebase propio** en `public/vendor/firebase-<versión>/`, así la CSP no permite scripts de la CDN. Para actualizarlo: `npm run vendor -- <versión>` y cambia `FIREBASE_VERSION` en `script.js`.
- **Validación de los datos** de cada punto (venga de Firestore o de `puntos.json`): solo se aceptan imágenes dentro de `assets/` o URLs `https` de Firebase Storage; se rechazan `javascript:`, `data:`, rutas con `..` y otros dominios. Los nombres se muestran siempre como texto, nunca como HTML.
- **Reglas de Firestore con validación**: además de exigir admin, cada escritura debe tener solo los campos conocidos, `modo` válido, `x`/`y` entre 0 y 100 e imágenes con el mismo formato permitido. El admin puede ser el email de las reglas o cualquier cuenta con el *custom claim* `admin: true`.

## 4. Desplegar

```bash
npm install -g firebase-tools   # si no lo tienes
firebase login
firebase deploy --only hosting,firestore:rules
```

Para probar en local: `firebase serve --only hosting` (o cualquier servidor estático apuntando a `public/`).
