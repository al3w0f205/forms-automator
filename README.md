# Forms Automator

Herramienta automatizada local de escritorio para el análisis y envío programático de encuestas de Google Forms.

## Características

- **Análisis Inteligente**: Extrae la estructura de cualquier formulario público a partir de su URL.
- **Distribución Estocástica**: Permite asignar pesos a las opciones múltiples para generar distribuciones probabilísticas realistas.
- **Ejecución Automatizada**: Envía decenas o cientos de formularios de forma controlada y simulando latencia para evitar rechazos del servidor.
- **Portable**: Empaquetable como un archivo ejecutable único `.exe` para su uso sin depender de Node.js.

## Requisitos Previos (Modo Desarrollo)

- Node.js (v20 o superior recomendado)
- npm (Node Package Manager)

## Instalación

1. Clonar el repositorio.
2. Instalar dependencias en el frontend y backend:

```bash
cd client
npm install
cd ../server
npm install
```

## Desarrollo

Para ejecutar el entorno de desarrollo:

- Levantar el frontend:
  ```bash
  npm run dev:client
  ```
- Levantar el servidor backend:
  ```bash
  npm run dev:server
  ```

## Compilación (Build Portable)

El sistema incluye un script integrado que genera una versión independiente y lista para su uso:

```bash
npm run build:portable
```

Este proceso compila el frontend, el backend y genera el ejecutable `FormsAutomator.exe` dentro de la carpeta `portable/`.

## Licencia

ISC
