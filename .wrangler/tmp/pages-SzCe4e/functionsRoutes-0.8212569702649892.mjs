import { onRequest as __api___path___js_onRequest } from "C:\\Users\\zhang\\Doubao\\chats\\2026-08-14\\new-chat\\functions\\api\\[[path]].js"

export const routes = [
    {
      routePath: "/api/:path*",
      mountPath: "/api",
      method: "",
      middlewares: [],
      modules: [__api___path___js_onRequest],
    },
  ]