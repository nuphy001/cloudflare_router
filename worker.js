// ===================================
// 1. 常量定义 - 放在文件最顶部
// ===================================

// 目标无头服务（Shopify Storefront API URL）
const HEADLESS_ORIGIN = "https://nuphy-develop-shop-7848d11901723dd15699.o2.myshopify.dev";

// 原始 Shopify 商店的域名 (用于构建回源 URL)
const SHOPIFY_ORIGIN_DOMAIN = "nuphy-develop.myshopify.com";
const SHOPIFY_ORIGIN = `https://${SHOPIFY_ORIGIN_DOMAIN}`;

// 主机头由 fetch 根据目标 URL 自动设置，无需手动覆盖

// 需要绕过（直接回源在线商店）的路径模式
const bypassPatterns = [
    '/checkout',
    '/checkouts/',
    '/cart', // 包含 /cart 子路径
    '/payments/',
    '/services/',
    '/wpm@'
];

const HEADLESS_ROUTES = {
    // 精确匹配 (仅保留 /cart)
    exact: new Set([
        '/collections/keyboards'
    ]),
    prefixes: [],
    patterns: []
};


// 最简单路由匹配：仅判断是否在 exact 集合中
function isHeadlessRoute(path) {
    // 仅一条热路径，用常量比较更快
    return path === '/collections/keyboards';
}

function shouldBypass(url) {
    const path = url.pathname;
    // 子域名以 checkout. 开头直接绕过
    if (url.hostname.startsWith('checkout.')) return true;
    // 路径前缀匹配
    for (const prefix of bypassPatterns) {
        if (path.startsWith(prefix)) return true;
    }
    // 针对 .myshopify.com/checkouts/ 的显式兜底（若被代理到该域时）
    if (url.href.includes('.myshopify.com/checkouts/')) return true;
    return false;
}

// ===================================
// 3. 主请求处理函数（最简路由规则）
// ===================================

async function handleRequest(request) {
    const startTime = performance.now();
    
    try {
        const url = new URL(request.url);
        const path = url.pathname;

        // 需要绕过的路径/子域名：直接透传到源站
        const forceShopify = shouldBypass(url);
        
        // 如果需要绕过，直接转发到 Shopify 源站
        if (forceShopify) {
            const shopifyUrl = SHOPIFY_ORIGIN + path + url.search;
            return fetch(shopifyUrl, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                redirect: 'manual'  // 保持重定向响应
            });
        }
        
        // 简单路由匹配（仅当非关键路径时才考虑无头路由）
        const isHeadless = isHeadlessRoute(path);
        const targetOrigin = isHeadless ? HEADLESS_ORIGIN : SHOPIFY_ORIGIN;
        
        // 构造目标 URL
        const targetHref = targetOrigin + path + url.search;
        
        // 记录请求开始时间
        const fetchStartTime = performance.now();
        
        const response = await fetch(targetHref, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: 'follow'
        });
        
        const fetchEndTime = performance.now();
        const totalDuration = fetchEndTime - startTime;
        const fetchDuration = fetchEndTime - fetchStartTime;
        console.log(`✅ ${request.method} ${path} -> ${isHeadless ? 'HEADLESS' : 'SHOPIFY'} | 总时间:${totalDuration.toFixed(2)}ms | 网络:${fetchDuration.toFixed(2)}ms`);
        
        return response;
        
    } catch (error) {
        const endTime = performance.now();
        const duration = endTime - startTime;
        console.error(`❌ 请求失败 (${duration.toFixed(2)}ms):`, error.message);
        
        return new Response('Internal Server Error', {
            status: 500,
            headers: {
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache'
            }
        });
    }
}


// ===================================
// 4. 事件监听器 - 放在文件最末尾
// ===================================

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});