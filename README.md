# cloudflare_router
    此项目是维护 cloudflare 的 router 规则， 目标是在旧店铺迁移的过程中， 代理特定的路由到新的店铺， 保留旧的路由到 在线商店。 


# 需求
在线商品的域名地址 ：nuphy-develop.myshopify.com
无头服务的域名地址 https://nuphy-develop-shop-7848d11901723dd15699.o2.myshopify.dev

当前简化规则：
仅保留 `/cart` 精确匹配走无头服务（不包含 `/cart/data.js` 等子路径）；
`/.well-known/...` 依旧走专项优化处理；
其他所有路径统一回源到在线商店。

性能要求

# 已知需要缓存的页面


# 出现问题
- 在在线商店加购， /cart 路由到了新的 Headless 页面， 但是在 新的 Headless 无法加减购物车。 主要原因是代理了 /cart 路径， 导致加购异常， 目前去除加购部分， 问题解决。 
-  这些以 /.well-known/shopify/monorail/... 开头的路径是 Shopify 的 Monorail 遥测/埋点上报接口（比如 unstable/produce_batch 批量上报事件）。它通常是 POST，负载体量小，成功返回即可，无需页面内容。
- 结算页异常  。  关键是将 redirect: 'manual' 用于绕过路径，这样 Shopify 返回的结账重定向会被正确传递给浏览器。试试这个修改，应该就能正常跳转到结账页面了！  redirect: 'manual'