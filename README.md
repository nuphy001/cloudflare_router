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

- 加购页显示异常 ： 在线商店 无法显示 ； Headless 无法操作。
  问题原因： cloudflare 代理了 /cart 路由 。 在线商店访问 /cart 都会到 Headless ， 所以无法访问。 Headless 购物车的操作 API 是与在线商店的 API 不一样的。
  解决方案： 不代理 /cart 路由 ， 问题 solved

- shopify 打标请求过慢 。 这些以 /.well-known/shopify/monorail/... 开头的路径是 Shopify 的 Monorail 遥测/埋点上报接口（比如 unstable/produce_batch 批量上报事件）。它通常是 POST，负载体量小，成功返回即可，无需页面内容。

- 结算页异常 。
  原因： 结算页对于 Header 有严格的安全要求， 比如使用 redirect: 'manual' ， 不能使用 follow 。
  关键是将 redirect: 'manual' 用于绕过路径，这样 Shopify 返回的结账重定向会被正确传递给浏览器。试试这个修改，应该就能正常跳转到结账页面了！ redirect: 'manual'

- 店铺开启 password 访问， 无法代理
  原因： cloudflare 默认开启 password 访问， 针对密码访问的页面， cloudflare 会将请求转发给 cloudflare 密码访问页面。需要有对应 response 设置。 因此需要特殊处理。
