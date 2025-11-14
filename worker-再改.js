// ===================================
// 1. 常量定义 - 放在文件最顶部
// ===================================

// 目标无头服务（Shopify Storefront API URL）
const HEADLESS_ORIGIN =
  "https://nuphy-develop-shop-7848d11901723dd15699.o2.myshopify.dev";

// 原始 Shopify 商店的域名 (用于构建回源 URL)
const SHOPIFY_ORIGIN_DOMAIN = "nuphy-develop.myshopify.com";
const SHOPIFY_ORIGIN = `https://${SHOPIFY_ORIGIN_DOMAIN}`;

// 主机头由 fetch 根据目标 URL 自动设置，无需手动覆盖

// 需要绕过（直接回源在线商店）的路径模式
const bypassPatterns = [
  "/checkout",
  "/checkouts/",
  "/cart", // 包含 /cart 子路径
  "/payments/",
  "/services/",
  "/wpm@",
];

const HEADLESS_ROUTES = {
  // 精确匹配 (仅保留 /cart)
  exact: new Set(["/collections/keyboards"]),
  prefixes: ["/account"],
  patterns: [],
};

// 最简单路由匹配：仅判断是否在 exact 集合中
function isHeadlessRoute(path) {
  // React Router manifest 文件
  if (path === "/__manifest") {
    return true;
  }
  // 前缀匹配账户路径
  if (path.startsWith("/account")) {
    return true;
  }
  // 仅一条热路径，用常量比较更快
  return path === "/collections/keyboards";
}

// 判断是否为密码保护相关路径
function isPasswordRelated(path) {
  return (
    path === "/password" ||
    path.startsWith("/password/") ||
    path === "/challenge" ||
    path.startsWith("/challenge/") ||
    path.includes("/password") ||
    path.includes("/challenge")
  );
}

function shouldBypass(url) {
  const path = url.pathname;
  // 子域名以 checkout. 开头直接绕过
  if (url.hostname.startsWith("checkout.")) return true;
  // 路径前缀匹配
  for (const prefix of bypassPatterns) {
    if (path.startsWith(prefix)) return true;
  }
  // 密码保护相关路径也需要绕过（走 Shopify）
  if (isPasswordRelated(path)) return true;
  // 针对 .myshopify.com/checkouts/ 的显式兜底（若被代理到该域时）
  if (url.href.includes(".myshopify.com/checkouts/")) return true;
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

    // ===== 特殊处理：/account-online 映射到在线商店 /account =====
    // 规则: nuphy.ai/account-online/*/** → nuphy-develop.myshopify.com/account/*/**
    if (path.startsWith("/account-online")) {
      // 去掉 -online 后缀，代理到在线商店
      const targetPath = path.replace("/account-online", "/account");
      const shopifyUrl = SHOPIFY_ORIGIN + targetPath + url.search;

      console.log(`🏪 在线商店: ${path} -> ${targetPath}`);

      const response = await fetch(shopifyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual", // 手动处理重定向
      });

      // 重写响应，保留 -online 后缀
      return await rewriteResponseForOnlineStore(response, url);
    }

    // 需要绕过的路径/子域名：直接透传到源站
    const forceShopify = shouldBypass(url);

    // 如果需要绕过，直接转发到 Shopify 源站
    if (forceShopify) {
      const shopifyUrl = SHOPIFY_ORIGIN + path + url.search;
      const response = await fetch(shopifyUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual", // 保持重定向响应，避免影响 checkout
      });

      // 对于密码保护相关路径，需要重写响应中的链接和 cookie ， 否则密码开启之后， 访问 500 ， 无法跳转
      if (isPasswordRelated(path)) {
        return rewritePasswordPageResponse(response, url);
      }

      return response;
    }

    // 简单路由匹配（仅当非关键路径时才考虑无头路由）
    // 规则: nuphy.ai/account/*/** → headless.myshopify.dev/account/*/**
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
      redirect: "manual", // 手动处理重定向，确保正确重写 Location header
    });

    const fetchEndTime = performance.now();
    const totalDuration = fetchEndTime - startTime;
    const fetchDuration = fetchEndTime - fetchStartTime;
    console.log(
      `✅ ${request.method} ${path} -> ${
        isHeadless ? "HEADLESS" : "SHOPIFY"
      } | 总时间:${totalDuration.toFixed(2)}ms | 网络:${fetchDuration.toFixed(
        2
      )}ms`
    );

    // 处理重定向响应 - 重写 Location header
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        return rewriteRedirectResponse(response, location, url, isHeadless);
      }
    }

    return response;
  } catch (error) {
    const endTime = performance.now();
    const duration = endTime - startTime;
    console.error(`❌ 请求失败 (${duration.toFixed(2)}ms):`, error.message);

    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "no-cache",
      },
    });
  }
}

// 统一的重定向响应重写函数
function rewriteRedirectResponse(response, location, originalUrl, isHeadless) {
  const newHeaders = new Headers(response.headers);
  let newLocation = location;

  // 处理完整 URL (包含 HEADLESS_ORIGIN 或 SHOPIFY_ORIGIN_DOMAIN)
  if (location.includes(HEADLESS_ORIGIN)) {
    // Headless 路由: 替换 Oxygen 域名为 nuphy.ai
    newLocation = location.replace(HEADLESS_ORIGIN, `https://${originalUrl.hostname}`);
    console.log(`🔀 无头商店重定向: ${location} -> ${newLocation}`);
  } else if (location.includes(SHOPIFY_ORIGIN_DOMAIN)) {
    // 在线商店路由: 替换域名并添加 -online 后缀
    const escapedDomain = SHOPIFY_ORIGIN_DOMAIN.replace(/\./g, "\\.");
    newLocation = location
      .replace(new RegExp(`https://${escapedDomain}`, "gi"), `https://${originalUrl.hostname}`)
      .replace(new RegExp(`http://${escapedDomain}`, "gi"), `https://${originalUrl.hostname}`);

    // 对路径添加 -online 后缀
    try {
      const urlObj = new URL(newLocation);
      if (urlObj.pathname.startsWith("/account")) {
        urlObj.pathname = urlObj.pathname.replace("/account", "/account-online");
      }
      newLocation = urlObj.toString();
    } catch (e) {
      console.error("URL 解析失败:", e);
    }
    console.log(`🔀 在线商店重定向: ${location} -> ${newLocation}`);
  }
  // 处理相对路径
  else if (location.startsWith("/")) {
    if (isHeadless) {
      // Headless 路由: 保持原路径
      newLocation = `https://${originalUrl.hostname}${location}`;
      console.log(`🔀 无头商店相对重定向: ${location} -> ${newLocation}`);
    } else {
      // 在线商店路由: 添加 -online 后缀
      if (location.startsWith("/account")) {
        newLocation = location.replace("/account", "/account-online");
      }
      newLocation = `https://${originalUrl.hostname}${newLocation}`;
      console.log(`🔀 在线商店相对重定向: ${location} -> ${newLocation}`);
    }
  }

  newHeaders.set("location", newLocation);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// 专门用于在线商店的响应重写函数（保留 -online 后缀）
async function rewriteResponseForOnlineStore(response, originalUrl) {
  try {
    const newHeaders = new Headers(response.headers);
    const escapedDomain = SHOPIFY_ORIGIN_DOMAIN.replace(/\./g, "\\.");

    // 处理重定向 - 特殊处理：需要保留 -online 后缀
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        let newLocation = location;

        // 如果是完整 URL，需要分两步处理
        if (location.includes(SHOPIFY_ORIGIN_DOMAIN)) {
          // 第一步：替换域名
          newLocation = location
            .replace(new RegExp(`https://${escapedDomain}`, "gi"), `https://${originalUrl.hostname}`)
            .replace(new RegExp(`http://${escapedDomain}`, "gi"), `https://${originalUrl.hostname}`);

          // 第二步：解析 URL，对路径添加 -online 后缀
          try {
            const urlObj = new URL(newLocation);
            if (urlObj.pathname.startsWith("/account")) {
              urlObj.pathname = urlObj.pathname.replace("/account", "/account-online");
            }
            newLocation = urlObj.toString();
          } catch (e) {
            console.error("URL 解析失败:", e);
          }
        }
        // 如果是相对路径（如 /account, /account/orders）
        else if (newLocation.startsWith("/")) {
          // 在 /account 路径前添加 -online 后缀
          if (newLocation.startsWith("/account")) {
            newLocation = newLocation.replace("/account", "/account-online");
          }
          newLocation = `https://${originalUrl.hostname}${newLocation}`;
        }

        console.log(`🔀 在线商店重定向: ${location} -> ${newLocation}`);
        newHeaders.set("location", newLocation);
      }
    }

    // 处理 Set-Cookie
    const setCookieHeaders = response.headers.getAll("set-cookie");
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      newHeaders.delete("set-cookie");
      setCookieHeaders.forEach((cookie) => {
        let rewrittenCookie = cookie
          .replace(/domain=\.?[^;]*\.myshopify\.com/gi, "")
          .replace(/domain=[^;]+/gi, "");

        rewrittenCookie = rewrittenCookie.replace(/^;\s*/, "").replace(/;\s*$/, "");

        if (rewrittenCookie && !rewrittenCookie.includes("domain=")) {
          rewrittenCookie += `; domain=.${originalUrl.hostname}`;
        }

        if (rewrittenCookie) {
          newHeaders.append("set-cookie", rewrittenCookie.trim());
        }
      });
    }

    // 如果是 HTML 响应，重写内容中的链接
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      let body = await response.text();

      // 替换域名
      body = body.replace(new RegExp(escapedDomain, "g"), originalUrl.hostname);
      body = body.replace(
        new RegExp(`https://${escapedDomain}`, "g"),
        `https://${originalUrl.hostname}`
      );

      // 替换 /account 链接为 /account-online
      body = body.replace(/href="\/account([\/"?])/gi, 'href="/account-online$1');
      body = body.replace(/href='\/account([\/'?])/gi, "href='/account-online$1");
      // 处理没有后续字符的情况
      body = body.replace(/href="\/account"/gi, 'href="/account-online"');
      body = body.replace(/href='\/account'/gi, "href='/account-online'");

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    if (response.status >= 300 && response.status < 400) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (error) {
    console.error("在线商店响应重写失败:", error);
    return response;
  }
}

// 处理密码页面响应
async function rewritePasswordPageResponse(response, originalUrl) {
  try {
    const newHeaders = new Headers(response.headers);
    const escapedDomain = SHOPIFY_ORIGIN_DOMAIN.replace(/\./g, "\\.");

    // 处理重定向响应（密码校验成功后会重定向）
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        // 重写 Location header，将 myshopify.com 域名替换为当前域名
        let newLocation = location
          .replace(
            new RegExp(`https://${escapedDomain}`, "gi"),
            `https://${originalUrl.hostname}`
          )
          .replace(
            new RegExp(`http://${escapedDomain}`, "gi"),
            `https://${originalUrl.hostname}`
          );

        // 如果是相对路径，确保使用当前域名
        if (newLocation.startsWith("/")) {
          newLocation = `https://${originalUrl.hostname}${newLocation}`;
        }

        newHeaders.set("location", newLocation);
      }
    }

    // 正确处理多个 Set-Cookie headers（Shopify 可能返回多个）
    const setCookieHeaders = response.headers.getAll("set-cookie");
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      // 删除所有旧的 Set-Cookie headers
      newHeaders.delete("set-cookie");

      // 重写每个 cookie 的 domain
      setCookieHeaders.forEach((cookie) => {
        // 移除或替换 myshopify.com domain，改为当前域名
        let rewrittenCookie = cookie
          .replace(/domain=\.?[^;]*\.myshopify\.com/gi, "") // 移除 myshopify.com domain
          .replace(/domain=[^;]+/gi, ""); // 移除其他 domain

        // 清理多余的分号
        rewrittenCookie = rewrittenCookie
          .replace(/^;\s*/, "")
          .replace(/;\s*$/, "");

        // 添加新的 domain（如果需要且 cookie 不为空）
        if (rewrittenCookie && !rewrittenCookie.includes("domain=")) {
          rewrittenCookie += `; domain=${originalUrl.hostname}`;
        }

        if (rewrittenCookie) {
          newHeaders.append("set-cookie", rewrittenCookie.trim());
        }
      });
    }

    // 如果是 HTML 响应，需要重写内容中的链接和域名
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      let body = await response.text();

      // 替换 myshopify.com 域名为当前域名（转义特殊字符）
      body = body.replace(new RegExp(escapedDomain, "g"), originalUrl.hostname);

      // 替换 https:// 协议中的域名
      body = body.replace(
        new RegExp(`https://${escapedDomain}`, "g"),
        `https://${originalUrl.hostname}`
      );

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // 对于重定向响应（3xx），直接返回重写后的 headers
    if (response.status >= 300 && response.status < 400) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // 对于其他非 HTML 响应，直接返回（但已重写 cookie）
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (error) {
    console.error("密码页面重写失败:", error);
    // 如果重写失败，返回原始响应，避免 500 错误
    return response;
  }
}

// ===================================
// 4. 事件监听器 - 放在文件最末尾
// ===================================

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
