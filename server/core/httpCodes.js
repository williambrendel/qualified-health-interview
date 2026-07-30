"use strict";

/**
 * @file httpCodes.js
 * @description Comprehensive registry of HTTP status codes, including standard,
 * vendor-specific, deprecated, and informal codes. Provides lookup by numeric
 * value or string key, a flat list, and a `statuses` map of key → value pairs.
 *
 * @example
 * const { statuses: { OK } } = require("./httpCodes"); // OK = 200
 * const { OK } = require("./httpCodes");               // OK = { name: "Ok", value: 200, ... }
 * const { list } = require("./httpCodes");             // list = [{ name: "Ok", value: 200, ... }, ...]
 */

// ---------------------------------------------------------------------------
// Code Groups
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CodeGroup
 * @property {string} name        - Human-readable group name (e.g. `"2xx successful response"`).
 * @property {string} description - Prose description of the group's semantics.
 * @property {Function} toString  - Returns a pretty-printed JSON representation (non-enumerable).
 */

/**
 * @function createCodeGroup
 * @description Creates a frozen {@link CodeGroup} descriptor.
 *
 * @param {string} name        - Group name.
 * @param {string} description - Group description.
 * @returns {CodeGroup} An immutable code-group descriptor.
 */
const createCodeGroup = (
  name,
  description
) => {
  const group = {
    name,
    description
  };

  Object.defineProperty(group, "toString", {
    value: function () {
      return JSON.stringify(this, null, 2);
    }
  });

  return Object.freeze(group);
}

/**
 * @type {CodeGroup[]}
 * @description Ordered array of {@link CodeGroup} descriptors indexed by HTTP class:
 * - `0` — `xxx` other / custom codes
 * - `1` — `1xx` informational responses
 * - `2` — `2xx` successful responses
 * - `3` — `3xx` redirection messages
 * - `4` — `4xx` client error responses
 * - `5` — `5xx` server error responses
 */
const codeGroup = [
  createCodeGroup(
    "xxx other response",
    "Custom codes."
  ),
  createCodeGroup(
    "1xx informational response",
    "An informational response indicates that the request was received and understood. It is issued on a provisional basis while request processing continues. It alerts the client to wait for a final response. The message consists only of the status line and optional header fields, and is terminated by an empty line. As the HTTP/1.0 standard did not define any 1xx status codes, servers must not send a 1xx response to an HTTP/1.0 compliant client except under experimental conditions."
  ),
  createCodeGroup(
    "2xx successful response",
    "This class of status codes indicates the action requested by the client was received, understood, and accepted."
  ),
  createCodeGroup(
    "3xx redirection message",
    "This class of status code indicates the client must take additional action to complete the request. Many of these status codes are used in URL redirection. A user agent may carry out the additional action with no user interaction only if the method used in the second request is GET or HEAD. A user agent may automatically redirect a request. A user agent should detect and intervene to prevent cyclical redirects."
  ),
  createCodeGroup(
    "4xx client error response",
    "This class of status code is intended for situations in which the error seems to have been caused by the client. Except when responding to a HEAD request, the server should include an entity containing an explanation of the error situation, and whether it is a temporary or permanent condition. These status codes are applicable to any request method. User agents should display any included entity to the user."
  ),
  createCodeGroup(
    "5xx server error response",
    "The server failed to fulfill a request. Response status codes beginning with the digit \"5\" indicate cases in which the server is aware that it has encountered an error or is otherwise incapable of performing the request. Except when responding to a HEAD request, the server should include an entity containing an explanation of the error situation, and indicate whether it is a temporary or permanent condition. Likewise, user agents should display any included entity to the user. These response codes are applicable to any request method."
  )
];

// ---------------------------------------------------------------------------
// Code helpers
// ---------------------------------------------------------------------------

/**
 * @function getKey
 * @description Derives a normalized uppercase lookup key from a code name.
 * Non-alphanumeric characters are replaced with `"_"`.
 *
 * @param {string} [name=""] - Raw code name (e.g. `"Not Found"`).
 * @returns {string} Uppercase key (e.g. `"NOT_FOUND"`).
 *
 * @example
 * getKey("Not Found");  // → "NOT_FOUND"
 * getKey("I'm a teapot"); // → "I_M_A_TEAPOT"
 */
const getKey = name => (name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/**
 * @function getType
 * @description Resolves the {@link CodeGroup} for a given HTTP status code value.
 *
 * | Range         | Group index | Label                    |
 * |---------------|-------------|--------------------------|
 * | falsy or >599 | 0           | xxx other response       |
 * | 100–199       | 1           | 1xx informational        |
 * | 200–299       | 2           | 2xx successful           |
 * | 300–399       | 3           | 3xx redirection          |
 * | 400–499       | 4           | 4xx client error         |
 * | 500–599       | 5           | 5xx server error         |
 *
 * @param {number} value - Numeric HTTP status code.
 * @returns {CodeGroup} The matching {@link CodeGroup} descriptor.
 */
const getType = value => (
  (!value || value > 599) && codeGroup[0]
  || (value < 200 && codeGroup[1])
  || (value < 300 && codeGroup[2])
  || (value < 400 && codeGroup[3])
  || (value < 500 && codeGroup[4])
  || codeGroup[5]
);

// ---------------------------------------------------------------------------
// Code descriptor
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HttpCode
 * @property {string}    name                  - Primary display name (e.g. `"Not Found"`).
 * @property {string}    key                   - Normalized uppercase key (e.g. `"NOT_FOUND"`).
 * @property {number}    value                 - Numeric status code (e.g. `404`).
 * @property {CodeGroup} type                  - {@link CodeGroup} this code belongs to.
 * @property {string}    description           - Prose description of the code's semantics.
 * @property {string}    [additionalInformation] - Extra context, RFC references, or caveats.
 * @property {string}    [alternateName]       - Alternative name recognized for this code.
 * @property {string}    [alternateKey]        - Normalized key derived from `alternateName`.
 * @property {true}      [deprecated]          - Present and `true` if the code is deprecated.
 * @property {string}    [specificTo]          - Vendor or platform this code is specific to
 *                                               (e.g. `"Nginx"`, `"AWS Elastic Load Balancing"`).
 * @property {Function}  toString              - Returns a pretty-printed JSON representation
 *                                               of the descriptor (non-enumerable).
 */

/**
 * @function createCode
 * @description Creates a frozen {@link HttpCode} descriptor.
 *
 * Optional properties (`additionalInformation`, `alternateName`, `deprecated`,
 * `specificTo`) are only added to the object when truthy, keeping descriptors lean.
 *
 * @param {string}  name                  - Primary code name.
 * @param {number}  value                 - Numeric status code.
 * @param {string}  description           - Prose description.
 * @param {string}  [additionalInformation] - Extra context or RFC reference.
 * @param {string}  [alternateName]       - Alternative name for the code.
 * @param {boolean} [deprecated=false]    - Pass `true` to mark the code as deprecated.
 * @param {string}  [specificTo]          - Vendor or platform the code is specific to.
 * @returns {HttpCode} An immutable HTTP code descriptor.
 *
 * @example
 * const ok = createCode("Ok", 200, "The request succeeded.");
 * // ok.key   → "OK"
 * // ok.value → 200
 * // ok.type  → codeGroup[2]  ("2xx successful response")
 */
const createCode = (
  name,
  value,
  description,
  additionalInformation,
  alternateName,
  deprecated,
  specificTo
) => {
  const code = {
    name,
    key: getKey(name),
    value,
    type: getType(value),
    description
  };

  additionalInformation && (
    code.additionalInformation = additionalInformation
  );
  alternateName && (
    code.alternateName = alternateName,
    code.alternateKey = getKey(alternateName)
  );
  deprecated && (code.deprecated = true);
  specificTo && (code.specificTo = specificTo);

  Object.defineProperty(code, "toString", {
    value: function () {
      return JSON.stringify(this, null, 2);
    }
  });

  return Object.freeze(code);
}

/**
 * @type {HttpCode[]}
 * @description Master list of all {@link HttpCode} descriptors, covering standard
 * HTTP codes (RFC 7231 and successors), WebDAV extensions, and vendor-specific
 * codes from Nginx, Cloudflare, AWS ELB, Shopify, Microsoft IIS, and others.
 * Ordered numerically by status code value within each class group.
 */
const codes = [
  createCode(
    "Go Away",
    0,
    "Returned with an HTTP/2 GOAWAY frame if the compressed length of any of the headers exceeds 8K bytes or if more than 10K requests are served through one connection.",
    "",
    "",
    false,
    "AWS Elastic Load Balancing"
  ),
  // 1xx informational response.
  createCode(
    "Continue",
    100,
    "This interim response indicates that the client should continue the request or ignore the response if the request is already finished."
  ),
  createCode(
    "Switching Protocols",
    101,
    "This code is sent in response to an \"Upgrade\" request header from the client and indicates the protocol the server is switching to."
  ),
  createCode(
    "Processing",
    102,
    "A WebDAV request may contain many sub-requests involving file operations, requiring a long time to complete the request. This code indicates that the server has received and is processing the request, but no response is available yet. This prevents the client from timing out and assuming the request was lost.",
    "WebDAV, RFC 2518",
    "",
    true
  ),
  createCode(
    "Early Hints",
    103,
    "Used to return some response headers before final HTTP message. This status code is primarily intended to be used with the Link header, letting the user agent start preloading resources while the server prepares a response or preconnect to an origin from which the page will need resources.",
    "RFC 8297"
  ),
  createCode(
    "Response is Stale",
    110,
    "The response provided by a cache is stale (the content's age exceeds a maximum age set by a Cache-Control header or heuristically chosen lifetime).",
    "",
    "RFC 7234",
    true
  ),
  createCode(
    "Revalidation Failed",
    111,
    "The cache was unable to validate the response, due to an inability to reach the origin server.",
    "",
    "RFC 7234",
    true
  ),
  createCode(
    "Disconnected Operation",
    112,
    "The cache is intentionally disconnected from the rest of the network.",
    "",
    "RFC 7234",
    true
  ),
  createCode(
    "Heuristic Expiration",
    113,
    "The cache heuristically chose a freshness lifetime greater than 24 hours and the response's age is greater than 24 hours.",
    "",
    "RFC 7234",
    true
  ),
  createCode(
    "Miscellaneous Warning",
    199,
    "Arbitrary, non-specific warning. The warning text may be logged or presented to the user.",
    "",
    "RFC 7234",
    true
  ),
  // 2xx successful responses.
  createCode(
    "Ok",
    200,
    `The request succeeded. The result and meaning of "success" depends on the HTTP method:
• GET: The resource has been fetched and transmitted in the message body.
• HEAD: Representation headers are included in the response without any message body.
• PUT or POST: The resource describing the result of the action is transmitted in the message body.
• TRACE: The message body contains the request as received by the server.`,
"Success"
  ),
  createCode(
    "Created",
    201,
    "The request has been fulfilled, resulting in the creation of a new resource. This is typically the response sent after POST requests, or some PUT requests."
  ),
  createCode(
    "Accepted",
    202,
    "The request has been accepted for processing, but the processing has not been completed. The request might or might not be eventually acted upon, and may be disallowed when processing occurs."
  ),
  createCode(
    "Non-Authoritative Information",
    203,
    "The server is a transforming proxy (e.g. a Web accelerator) that received a 200 OK from its origin, but is returning a modified version of the origin's response. In other words, the returned metadata is not exactly the same as is available from the origin server, but is collected from a local or a third-party copy. This is mostly used for mirrors or backups of another resource. Except for that specific case, the 200 OK response is preferred to this status.",
    "Since HTTP/1.1"
  ),
  createCode(
    "No Content",
    204,
    "There is no content to send for this request, but the headers are useful. The user agent may update its cached headers for this resource with the new ones."
  ),
  createCode(
    "Reset Content",
    205,
    "The server successfully processed the request, and tells the user agent to reset the document which sent this request. Also, is not returning any content."
  ),
  createCode(
    "Partial Content",
    206,
    "The server is delivering only part of the resource (byte serving) due to a range header sent by the client. The range header is used by HTTP clients to enable resuming of interrupted downloads, or split a download into multiple simultaneous streams."
  ),
  createCode(
    "Multi-Status",
    207,
    "The message body that follows is by default an XML message and can contain a number of separate response codes, depending on how many sub-requests were made.",
    "WebDAV, RFC 4918"
  ),
  createCode(
    "Already Reported",
    208,
    "The members of a DAV binding have already been enumerated in a preceding part of the (multistatus) response, and are not being included again, i.e. used inside a <dav:propstat> response element to avoid repeatedly enumerating the internal members of multiple bindings to the same collection.",
    "WebDAV, RFC 5842"
  ),
  createCode(
    "Transformation Applied",
    214,
    "Added by a proxy if it applies any transformation to the representation, such as changing the content encoding, media type or the like.",
    "",
    "RFC 7234",
    true
  ),
  createCode(
    "This Is Fine",
    218,
    "Used by Apache servers. A catch-all error condition allowing the passage of message bodies through the server when the ProxyErrorOverride setting is enabled. It is displayed in this situation instead of a 4xx or 5xx error message.",
    "Apache HTTP Server"
  ),
  createCode(
    "IM used",
    226,
    "The server has fulfilled a GET request for the resource, and the response is a representation of the result of one or more instance-manipulations applied to the current instance.",
    "RFC 3229, HTTP Delta encoding"
  ),
  createCode(
    "Miscellaneous Persistent Warning",
    299,
    "Same as 199, but indicating a persistent warning.",
    "",
    "RFC 7234",
    true
  ),
  // 3xx redirection messages
  createCode(
    "Multiple Choices",
    300,
    ""
  ),
  createCode(
    "Moved Permanently",
    301,
    ""
  ),
  createCode(
    "Found",
    302,
    "Tells the client to look at (browse to) another URL. The HTTP/1.0 specification required the client to perform a temporary redirect with the same method (the original describing phrase was \"Moved Temporarily\"), but popular browsers implemented 302 redirects by changing the method to GET. Therefore, HTTP/1.1 added status codes 303 and 307 to distinguish between the two behaviours.",
    "",
    "Moved Temporarily"
  ),
  createCode(
    "See Other",
    303,
    "The response to the request can be found under another URI using the GET method. When received in response to a POST (or PUT/DELETE), the client should presume that the server has received the data and should issue a new GET request to the given URI.",
    "Since HTTP/1.1"
  ),
  createCode(
    "Not Modified",
    304,
    "This is used for caching purposes. It tells the client that the response has not been modified, so the client can continue to use the same cached version of the response."
  ),
  createCode(
    "Use Proxy",
    305,
    "Since HTTP/1.1",
    "Defined in a previous version of the HTTP specification to indicate that a requested response must be accessed by a proxy. It has been deprecated due to security concerns regarding in-band configuration of a proxy.",
    "",
    true
  ),
  createCode(
    "Unused",
    306,
    "No longer used; but is reserved. Originally meant \"Subsequent requests should use the specified proxy\", and was used in a previous version of the HTTP/1.1 specification.",
    "",
    "Switch Proxy"
  ),
  createCode(
    "Temporary Redirect",
    307,
    "The server sends this response to direct the client to get the requested resource at another URI with the same method that was used in the prior request. This has the same semantics as the 302 Found response code, with the exception that the user agent must not change the HTTP method used: if a POST was used in the first request, a POST must be used in the redirected request."
  ),
  createCode(
    "Permanent Redirect",
    308,
    "This means that the resource is now permanently located at another URI, specified by the Location response header. This has the same semantics as the 301 Moved Permanently HTTP response code, with the exception that the user agent must not change the HTTP method used: if a POST was used in the first request, a POST must be used in the second request."
  ),
  // 4xx client error responses.
  createCode(
    "Bad Request",
    400,
    "The server cannot or will not process the request due to something that is perceived to be a client error (e.g., malformed request syntax, invalid request message framing, or deceptive request routing)."
  ),
  createCode(
    "Unauthorized",
    401,
    "Although the HTTP standard specifies \"unauthorized\", semantically this response means \"unauthenticated\". That is, the client must authenticate itself to get the requested response."
  ),
  createCode(
    "Payment Required",
    402,
    "The initial purpose of this code was for digital payment systems, however this status code is rarely used and no standard convention exists.  Google Developers API uses this status if a particular developer has exceeded the daily limit on requests. Sipgate uses this code if an account does not have sufficient funds to start a call. Shopify uses this code when the store has not paid their fees and is temporarily disabled. Stripe uses this code for failed payments where parameters were correct, for example blocked fraudulent payments."
  ),
  createCode(
    "Forbidden",
    403,
    "The client does not have access rights to the content; that is, it is unauthorized, so the server is refusing to give the requested resource. Unlike 401 Unauthorized, the client's identity is known to the server."
  ),
  createCode(
    "Not Found",
    404,
    "The server cannot find the requested resource. In the browser, this means the URL is not recognized. In an API, this can also mean that the endpoint is valid but the resource itself does not exist. Servers may also send this response instead of 403 Forbidden to hide the existence of a resource from an unauthorized client. This response code is probably the most well known due to its frequent occurrence on the web."
  ),
  createCode(
    "Method Not Allowed",
    405,
    "The request method is known by the server but is not supported by the target resource. For example, an API may not allow DELETE on a resource, or the TRACE method entirely."
  ),
  createCode(
    "Not Acceptable",
    406,
    "Sent when the web server, after performing server-driven content negotiation, doesn't find any content that conforms to the criteria given by the user agent."
  ),
  createCode(
    "Proxy Authentication Required",
    407,
    "This is similar to 401 Unauthorized but authentication is needed to be done by a proxy."
  ),
  createCode(
    "Request Timeout",
    408,
    "Sent on an idle connection by some servers, even without any previous request by the client. It means that the server would like to shut down this unused connection. This response is used much more since some browsers use HTTP pre-connection mechanisms to speed up browsing. Some servers may shut down a connection without sending this message."
  ),
  createCode(
    "Conflict",
    409,
    "Sent when a request conflicts with the current state of the server. In WebDAV remote web authoring, 409 responses are errors sent to the client so that a user might be able to resolve a conflict and resubmit the request."
  ),
  createCode(
    "Gone",
    410,
    "Sent when the requested content has been permanently deleted from server, with no forwarding address. Clients are expected to remove their caches and links to the resource. The HTTP specification intends this status code to be used for \"limited-time, promotional services\". APIs should not feel compelled to indicate resources that have been deleted with this status code."
  ),
  createCode(
    "Length Required",
    411,
    "Server rejected the request because the Content-Length header field is not defined and the server requires it."
  ),
  createCode(
    "Precondition Failed",
    412,
    "In conditional requests, the client has indicated preconditions in its headers which the server does not meet."
  ),
  createCode(
    "Payload Too Large",
    413,
    "The request body is larger than limits defined by server. The server might close the connection or return an Retry-After header field.",
    "",
    "Content Too Large"
  ),
  createCode(
    "URI Too Long",
    414,
    "The URI requested by the client is longer than the server is willing to interpret."
  ),
  createCode(
    "Unsupported Media Type",
    415,
    "The media format of the requested data is not supported by the server, so the server is rejecting the request."
  ),
  createCode(
    "Range Not Satisfiable",
    416,
    "The ranges specified by the Range header field in the request cannot be fulfilled. It's possible that the range is outside the size of the target resource's data."
  ),
  createCode(
    "Expectation Failed",
    417,
    "This response code means the expectation indicated by the Expect request header field cannot be met by the server."
  ),
  createCode(
    "I'm a teapot",
    418,
    "This code was defined in 1998 as one of the traditional IETF April Fools' jokes, in RFC 2324, Hyper Text Coffee Pot Control Protocol, and is not expected to be implemented by actual HTTP servers. The RFC specifies this code should be returned by teapots requested to brew coffee. This HTTP status is used as an Easter egg in some websites, such as Google.com's \"I'm a teapot\" easter egg. Sometimes, this status code is also used as a response to a blocked request, instead of the more appropriate 403 Forbidden.",
    "RFC 2324, RFC 7168"
  ),
  createCode(
    "Page Expired",
    419,
    "Used by the Laravel Framework when a CSRF Token is missing or expired.",
    "",
    "",
    false,
    "Laravel Framework"
  ),
  createCode(
    "Method Failure",
    420,
    "A deprecated response status proposed during the development of WebDAV. Used by the Spring Framework when a method has failed. Returned by version 1 of the Twitter Search and Trends API when the client is being rate limited; versions 1.1 and later use the 429 Too Many Requests response code instead.",
    "WebDAV",
    "Enhance Your Calm",
    true,
    "Spring Framework"
  ),
  createCode(
    "Misdirected Request",
    421,
    "The request was directed at a server that is not able to produce a response. This can be sent by a server that is not configured to produce responses for the combination of scheme and authority that are included in the request URI."
  ),
  createCode(
    "Unprocessable Content",
    422,
    "The request was well-formed but was unable to be followed due to semantic errors.",
    "WebDAV"
  ),
  createCode(
    "Locked",
    423,
    "The resource that is being accessed is locked.",
    "WebDAV, RFC 4918",
  ),
  createCode(
    "Failed Dependency",
    424,
    "The request failed because it depended on another request and that request failed (e.g., a PROPPATCH).",
    "WebDAV; RFC 4918"
  ),
  createCode(
    "Too Early",
    425,
    "Indicates that the server is unwilling to risk processing a request that might be replayed.",
    "RFC 8470"
  ),
  createCode(
    "Upgrade Required",
    426,
    "The server refuses to perform the request using the current protocol but might be willing to do so after the client upgrades to a different protocol. The server sends an Upgrade header in a 426 response to indicate the required protocol(s)."
  ),
  createCode(
    "Precondition Required",
    428,
    "The origin server requires the request to be conditional. This response is intended to prevent the 'lost update' problem, where a client GETs a resource's state, modifies it and PUTs it back to the server, when meanwhile a third party has modified the state on the server, leading to a conflict.",
    "RFC 6585"
  ),
  createCode(
    "Too Many Requests",
    429,
    "The user has sent too many requests in a given amount of time (rate limiting).",
    "RFC 6585"
  ),
  createCode(
    "Shopify Security Rejection",
    430,
    "Used by Shopify to signal that the request was deemed malicious. Also a deprecated response used by Shopify, instead of the 429 Too Many Requests response code, when too many URLs are requested within a certain time frame.",
    "",
    "Shopify Request Header Fields Too Large",
    true,
    "Shopify"
  ),
  createCode(
    "Request Header Fields Too Large",
    431,
    "The server is unwilling to process the request because its header fields are too large. The request may be resubmitted after reducing the size of the request header fields.",
    "RFC 6585"
  ),
  createCode(
    "Offline",
    433,
    "No internet connection on the client side",
    "",
    "",
    false,
    "Custom"
  ),
  createCode(
    "Login Time-out",
    440,
    "Login time-out",
    "",
    "",
    false,
    "Microsoft"
  ),
  createCode(
    "Retry With",
    449,
    "The server cannot honour the request because the user has not provided the required information.",
    "",
    "",
    false,
    "Microsoft"
  ),
  createCode(
    "No Response",
    444,
    "Used internally to instruct the server to return no information to the client and close the connection immediately.",
    "",
    "",
    false,
    "Nginx"
  ),
  createCode(
    "Blocked by Windows Parental Controls",
    450,
    "The Microsoft extension code indicated when Windows Parental Controls are turned on and are blocking access to the requested webpage.",
    "",
    "",
    false,
    "Microsoft"
  ),
  createCode(
    "Unavailable For Legal Reasons",
    451,
    "The user agent requested a resource that cannot legally be provided, such as a web page censored by a government. Also used in Exchange ActiveSync when either a more efficient server is available or the server cannot access the users' mailbox.[45] The client is expected to re-run the HTTP AutoDiscover operation to find a more appropriate server.",
    "RFC 7725",
    "Redirect"
  ),
  createCode(
    "Client Timeout Before Load Balancer's Timeout",
    460,
    "Client closed the connection with the load balancer before the idle timeout period elapsed. Typically, when client timeout is sooner than the Elastic Load Balancer's timeout.",
    "",
    "",
    false,
    "AWS Elastic Load Balancing"
  ),
  createCode(
    "IP Address Overload",
    463,
    "The load balancer received an X-Forwarded-For request header with more than 30 IP addresses.",
    "",
    "",
    false,
    "AWS Elastic Load Balancing"
  ),
  createCode(
    "Incompatible Protocol Versions Between Client And Origin Server.",
    464,
    "Incompatible protocol versions between Client and Origin server.",
    "",
    "",
    false,
    "AWS Elastic Load Balancing"
  ),
  createCode(
    "Request Header Too Large",
    494,
    "Client sent too large request or too long header line.",
    "",
    "",
    false,
    "Nginx"
  ),
  createCode(
    "SSL Certificate Error",
    495,
    "An expansion of the 400 Bad Request response code, used when the client has provided an invalid client certificate.",
    "",
    "",
    false,
    "Nginx"
  ),
  createCode(
    "SSL Certificate Required",
    496,
    "An expansion of the 400 Bad Request response code, used when a client certificate is required but not provided.",
    "",
    "",
    false,
    "Nginx"
  ),
  createCode(
    "HTTP Request Sent To HTTPS Port",
    497,
    "An expansion of the 400 Bad Request response code, used when the client has made a HTTP request to a port listening for HTTPS requests.",
    "",
    "",
    false,
    "Nginx"
  ),
  createCode(
    "Invalid Token",
    498,
    "Returned by ArcGIS for Server. Code 498 indicates an expired or otherwise invalid token.",
    "",
    "",
    false,
    "Esri"
  ),
  createCode(
    "Token Required",
    499,
    "Returned by ArcGIS for Server. Code 499 indicates that a token is required but was not submitted. Also used when the client has closed the request before the server could send a response.",
    "",
    "Client Closed Request",
    false,
    "Esri, Nginx"
  ),
  // 5xx server error responses.
  createCode(
    "Internal Server Error",
    500,
    "The server has encountered a situation it does not know how to handle. This error is generic, indicating that the server cannot find a more appropriate 5XX status code to respond with."
  ),
  createCode(
    "Not Implemented",
    501,
    "The request method is not supported by the server and cannot be handled. The only methods that servers are required to support (and therefore that must not return this code) are GET and HEAD."
  ),
  createCode(
    "Bad Gateway",
    502,
    "This error response means that the server, while working as a gateway to get a response needed to handle the request, got an invalid response."
  ),
  createCode(
    "Service Unavailable",
    503,
    "The server is not ready to handle the request. Common causes are a server that is down for maintenance or that is overloaded. Note that together with this response, a user-friendly page explaining the problem should be sent. This response should be used for temporary conditions and the Retry-After HTTP header should, if possible, contain the estimated time before the recovery of the service. The webmaster must also take care about the caching-related headers that are sent along with this response, as these temporary condition responses should usually not be cached."
  ),
  createCode(
    "Gateway Timeout",
    504,
    "This error response is given when the server is acting as a gateway and cannot get a response in time."
  ),
  createCode(
    "HTTP Version Not Supported",
    505,
    "The HTTP version used in the request is not supported by the server."
  ),
  createCode(
    "Variant Also Negotiates",
    506,
    "The server has an internal configuration error: during content negotiation, the chosen variant is configured to engage in content negotiation itself, which results in circular references when creating responses.",
    "RFC 2295"
  ),
  createCode(
    "Insufficient Storage",
    507,
    "The method could not be performed on the resource because the server is unable to store the representation needed to successfully complete the request.",
    "WebDAV, RFC 4918"
  ),
  createCode(
    "Loop Detected",
    508,
    "The server detected an infinite loop while processing the request.",
    "WebDAV, RFC 5842"
  ),
  createCode(
    "Bandwidth Limit Exceeded",
    509,
    "The server has exceeded the bandwidth specified by the server administrator; this is often used by shared hosting providers to limit the bandwidth of customers.",
    "",
    "",
    false,
    "Apache Web Server, cPanel"
  ),
  createCode(
    "Not Extended",
    510,
    "The client request declares an HTTP Extension (RFC 2774) that should be used to process the request, but the extension is not supported.",
    "RFC 2774"
  ),
  createCode(
    "Network Authentication Required",
    511,
    "Indicates that the client needs to authenticate to gain network access.",
    "RFC 6585"
  ),
  createCode(
    "Web Server Returned An Unknown Error",
    520,
    "The origin server returned an empty, unknown, or unexpected response to Cloudflare.",
    "",
    "",
    false,
    "Cloudflare"
  ),
  createCode(
    "Web Server Is Down",
    521,
    "The origin server refused connections from Cloudflare. Security solutions at the origin may be blocking legitimate connections from certain Cloudflare IP addresses.",
    "",
    "",
    false,
    "Cloudflare"
  ),
  createCode(
    "Connection Timed Out",
    522,
    "Cloudflare timed out contacting the origin server.",
    "",
    "",
    false,
    "Cloudflare"
  ),
  createCode(
    "Origin Is Unreachable",
    523,
    "Cloudflare could not reach the origin server; for example, if the DNS records for the origin server are incorrect or missing.",
    "",
    "",
    false,
    "Cloudflare"
  ),
  createCode(
    "A Timeout Occurred",
    524,
    "Cloudflare was able to complete a TCP connection to the origin server, but did not receive a timely HTTP response.",
    "",
    "",
    false,
    "Cloudflare"
  ),
  createCode(
    "SSL Handshake Failed",
    525,
    "Cloudflare could not negotiate a SSL/TLS handshake with the origin server.",
    "",
    "",
    false,
    "Cloudflare"
  ),
  createCode(
    "Invalid SSL Certificate",
    526,
    "Cloudflare could not validate the SSL certificate on the origin web server. Also used by Cloud Foundry's gorouter.",
    "",
    "",
    false,
    "Cloudflare, Cloud Foundry"
  ),
  createCode(
    "Railgun Error",
    527,
    "Error 527 indicated an interrupted connection between Cloudflare and the origin server's Railgun server. This error is obsolete as Cloudflare has deprecated Railgun.",
    "",
    "",
    true,
    "Cloudflare"
  ),
  createCode(
    "Site Is Overloaded",
    529,
    "Used by Qualys in the SSLLabs server testing API to signal that the site can not process the request.",
    "",
    "",
    false,
    "Qualys"
  ),
  createCode(
    "Site Is Frozen",
    530,
    "Used by the Pantheon Systems web platform to indicate a site that has been frozen due to inactivity. Also used by Shopify to indicate that Cloudflare can't resolve the requested DNS record.",
    "",
    "Origin DNS Error",
    false,
    "Pantheon Systems, Shopify, Cloudflare"
  ),
  createCode(
    "Temporarily Disabled",
    540,
    "Used by Shopify to indicate that the requested endpoint has been temporarily disabled.",
    "",
    "",
    false,
    "Shopify"
  ),
  createCode(
    "Unauthorized Authentication",
    561,
    "An error around authentication returned by a server registered with a load balancer. A listener rule is configured to authenticate users, but the identity provider (IdP) returned an error code when authenticating the user.",
    "",
    "Authentication Error",
    false,
    "AWS Elastic Load Balancing"
  ),
  createCode(
    "Network Read Timeout Error",
    598,
    "Used by some HTTP proxies to signal a network read timeout behind the proxy to a client in front of the proxy.",
    "Informal convention"
  ),
  createCode(
    "Network Connect Timeout Error",
    599,
    "An error used by some HTTP proxies to signal a network connect timeout behind the proxy to a client in front of the proxy."
  ),
  // xxx other codes.
  createCode(
    "Unexpected Token",
    783,
    "Used by Shopify to indicate that the request includes a JSON syntax error.",
    "",
    "",
    false,
    "Shopify"
  ),
  createCode(
    "Non-Standard",
    999,
    "Error 999 is used by LinkedIn and is related to being blocked/walled or unable to access their webpages without first signing in.",
    "",
    "",
    false,
    "LinkedIn"
  ),
];

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} HttpCodes
 * @description
 * Index object providing multi-key access to every {@link HttpCode} descriptor,
 * plus utility members for enumeration and lookup.
 *
 * Each code is registered under **two** keys:
 * - Its normalized uppercase string key (e.g. `"NOT_FOUND"`).
 * - Its numeric status code value (e.g. `404`).
 *
 * Codes with an `alternateName` are additionally registered under their
 * `alternateKey` as well.
 *
 * @property {HttpCode}  [key]     - Any normalized code key (e.g. `httpCodes.NOT_FOUND`).
 * @property {HttpCode}  [value]   - Any numeric code value (e.g. `httpCodes[404]`).
 * @property {HttpCode[]} list     - Flat ordered array of all {@link HttpCode} descriptors.
 * @property {Function}  get       - {@link httpCodes.get} lookup helper.
 * @property {Object}    statuses  - Map of every registered key/value → numeric status code.
 */

/**
 * @type {HttpCodes}
 */
const httpCodes = {};
for (let i = 0, l = codes.length, code; i !== l; ++i) {
  const { key, value, alternateKey } = code = codes[i];
  httpCodes[key] = httpCodes[value] = code;
  Array.isArray(alternateKey) && alternateKey.map(k => httpCodes[k] = code)
    || (alternateKey && (httpCodes[alternateKey] = code));
}

/**
 * @name httpCodes.list
 * @type {HttpCode[]}
 * @description Flat ordered array of every {@link HttpCode} descriptor.
 * Identical to the `codes` source array.
 */
httpCodes.list = codes;

/**
 * @function httpCodes.get
 * @description Looks up an {@link HttpCode} descriptor by string name or numeric value.
 *
 * String lookups are normalized via {@link getKey} before searching, so casing
 * and punctuation are ignored.
 *
 * @param {string|number} keyOrValue - Code name (e.g. `"Not Found"`) or numeric
 *                                     value (e.g. `404`).
 * @returns {HttpCode|null} The matching descriptor, or `null` if not found.
 *
 * @example
 * httpCodes.get("Not Found"); // → HttpCode { name: "Not Found", value: 404, ... }
 * httpCodes.get(404);         // → HttpCode { name: "Not Found", value: 404, ... }
 * httpCodes.get("unknown");   // → null
 */
httpCodes.get = keyOrValue => (
  typeof keyOrValue === "string" && httpCodes[getKey(keyOrValue)]
  || (typeof keyOrValue === "number") && httpCodes[keyOrValue]
  || null
);

/**
 * @name httpCodes.statuses
 * @type {Object.<string, number>}
 * @description Flat map of every registered key (string or numeric) to its
 * corresponding numeric status code. Useful for concise destructured imports.
 *
 * @example
 * const { statuses: { OK, NOT_FOUND } } = require("./httpCodes");
 * // OK       → 200
 * // NOT_FOUND → 404
 */
const statuses = httpCodes.statuses = {};
for (const k in httpCodes) {
  statuses[k] = httpCodes[k].value;
}

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(httpCodes, "httpCodes", {
  value: httpCodes
}));