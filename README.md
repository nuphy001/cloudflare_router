# cloudflare_router 背景

    此项目是维护 cloudflare 的 router 规则， 目标是在旧店铺迁移的过程中， 代理特定的路由到新的店铺， 保留旧的路由到 在线商店。

# 需求

用户统一访问的域名是： nuphy.ai
在线商品的域名地址 ：nuphy-develop.myshopify.com
无头服务的域名地址 https://nuphy-develop-shop-7848d11901723dd15699.o2.myshopify.dev

# 规则

明确已经迁移完成的新页面 /collections/keyboards ， 那么访问 nuphy.ai/collections/keyboards 就会跳转到 https://nuphy-develop-shop-7848d11901723dd15699.o2.myshopify.dev/collections/keyboards 页面 但是对于用户来说， 看到的路径是 最终看到 nuphy.ai/collections/keyboards 。

没有完成迁移的页面， 访问 nuphy.ai/collections/keycaps 跳转到 https://nuphy-develop.myshopify.com/collections/keycaps 。 最终
用户 看到的路径 是 nuphy.ai/collections/keycaps

如果是已经要返回到 在线商店的页面，则注意使用 if (forceShopify) {
const shopifyUrl = SHOPIFY_ORIGIN + path + url.search;
const response = await fetch(shopifyUrl, {
method: request.method,
headers: request.headers,
body: request.body,
redirect: "manual", // 保持重定向响应，避免影响 checkout
});
注意是 manual .
