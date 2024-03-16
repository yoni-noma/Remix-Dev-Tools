import { Plugin, normalizePath } from "vite";
import { parse } from "es-module-lexer";

import { cutArrayToLastN } from "../client/utils/common.js";
 
import { DevToolsServerConfig } from "../server/config.js";
import { handleDevToolsViteRequest, /**processPlugins */ } from "./utils.js";
import { ActionEvent, LoaderEvent } from "../server/event-queue.js"; 
import { RdtClientConfig } from "../client/context/RDTContext.js"; 

declare global {
  interface Window {
    RDT_MOUNTED: boolean;
  }
}

const routeInfo = new Map<string, { loader: LoaderEvent[]; action: ActionEvent[] }>();


type RemixViteConfig = {
  client?: Partial<RdtClientConfig>;
  server?: DevToolsServerConfig,
  pluginDir?: string;
  includeInProd?: boolean
};
 
export const defineRdtConfig = (config: RemixViteConfig) =>  config
 
export const remixDevTools: (args?:RemixViteConfig) => Plugin[] = (args) => {
  const serverConfig = args?.server || {};
  const clientConfig = args?.client || {};
//  const pluginDir = args?.pluginDir || undefined;
  const include = args?.includeInProd??false;
//  const plugins = pluginDir ? processPlugins(pluginDir) : [];
 // const pluginNames = plugins.map((p) => p.name);
  const shouldInject = (mode: string | undefined) => mode === "development" || include;
  let port = 5173;
  return [
   
    {
      enforce: "pre",
      name: "remix-development-tools-server",
      apply(config) {
        return shouldInject(config.mode);
      }, 
      transform(code) {
        const RDT_PORT = "__REMIX_DEVELOPMENT_TOOL_SERVER_PORT__";
        if (code.includes(RDT_PORT)) {
          const modified = code.replaceAll(RDT_PORT, port.toString()).replaceAll(`singleton("config", () => ({}));`, `(${JSON.stringify(serverConfig)})`); 
          return modified;
        }
      },
      async configureServer(server) {
        server.httpServer?.on("listening", () => {
          port = server.config.server.port ?? 5173;
        });
        server.middlewares.use((req, res, next) =>
          {
 
              handleDevToolsViteRequest(req, res, next, (parsedData) => {
              const { type, data } = parsedData;
              const id = data.id;
              const existingData = routeInfo.get(id);
              if (existingData) {
                if (type === "loader") {
                  existingData.loader = cutArrayToLastN([...existingData.loader, data], 30);
                }
                if (type === "action") {
                  existingData.action = cutArrayToLastN([...existingData.action, data], 30);
                }
              } else {
                if (type === "loader") {
                  routeInfo.set(id, { loader: [data], action: [] });
                }
                if (type === "action") {
                  routeInfo.set(id, { loader: [], action: [data] });
                }
              }
              server.hot.channels.forEach((client) => {
                client.send("route-info", JSON.stringify({ type, data }));
              });
            })
          }
        );
        server.hot.on("all-route-info", (data, client) => {
          client.send("all-route-info",  JSON.stringify({
            type: "all-route-info",
            data: Object.fromEntries(routeInfo.entries()),
          }))
        });

        if(!server.config.isProduction){
           const { exec } = await import ("node:child_process") 
          server.hot.on("open-source", (data) => { 
          const source = data.data.source; 
          const line = data.data.line;
          exec(`webstorm -g "${normalizePath(source)}:${line}"`)
          })
        }
      },
    },
    {
      name: "remix-development-tools",
      
      apply(config) { 
        return shouldInject(config.mode);
      },
      
      async configResolved(resolvedViteConfig){
        const remixIndex = resolvedViteConfig.plugins.findIndex(p => p.name === "remix");
        const devToolsIndex = resolvedViteConfig.plugins.findIndex(p => p.name === "remix-development-tools");
      
        if(remixIndex >= 0 && devToolsIndex > remixIndex){
          throw new Error("remixDevTools plugin has to be before the remix plugin!")
        }
         
      },
      transform(code, id) {
        
        // Wraps loaders/actions
        if (id.includes("virtual:server-entry") || id.includes("virtual:remix/server-build")) {
          const updatedCode = [
            `import { augmentLoadersAndActions } from "remix-development-tools/server";`,
            code.replace("export const routes =", "const routeModules ="),
            `export const routes = augmentLoadersAndActions(routeModules);`,
          ].join("\n");

          return updatedCode;
        }
        if (id.endsWith("/root.tsx")) {
          const [, exports] = parse(code);
          const exportNames = exports.map((e) => e.n);
          const hasLinksExport = exportNames.includes("links");
          const lines = code.split("\n");
         
          const imports = [
            'import { withViteDevTools } from "remix-development-tools/client";',
            'import rdtStylesheet from "remix-development-tools/client.css?url";',
            'import "remix-development-tools/client.css?inline";',
         //   plugins.map((plugin) => `import { ${plugin.name} } from "${plugin.path}";`).join("\n"),
          ];

          const augmentedLinksExport = hasLinksExport
            ? `export const links = () => [...linksExport(), { rel: "stylesheet", href: rdtStylesheet }];`
            : `export const links = () => [{ rel: "stylesheet", href: rdtStylesheet }];`;

          const augmentedDefaultExport = `export default withViteDevTools(AppExport, { config: ${JSON.stringify(clientConfig)}, plugins: [${
            //pluginNames.join(
            //","
          //)
        ""}] })();`;
          
          const updatedCode = lines.map((line) => {
          
            // Handles default export augmentation
            if (line.includes("export default function")) {
              const exportName = line.split("export default function ")[1].split("(")[0].trim();
              const newLine = line.replace(`export default function ${exportName}`, `function AppExport`);
              return newLine;
            } else if (line.includes("export default")) {
              const newline = line.replace("export default", "const AppExport =");
              return newline;
            }
            // Handles links export augmentation
            if (line.includes("export const links")) {
              return line.replace("export const links", "const linksExport");
            }
            if (line.includes("export let links")) {
              return line.replace("export let links", "const linksExport");
            }
            if (line.includes("export function links")) {
              return line.replace("export function links", "function linksExport");
            }
            // export { links } from "/app/root.tsx" variant
            if(line.includes("export {") && line.includes("links") && line.includes("/app/root")) {

              return line.replace("links", "links as linksExport");
            }
            return line;
          });
          // Returns the new code
          return [...imports, ...updatedCode, augmentedLinksExport, augmentedDefaultExport].join("\n");
        }
      },
    },
  ];
};
