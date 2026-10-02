# Commerce and website connectors

Open an assistant, choose **Knowledge → Connect store**, select a provider, and import. Relay creates a read-only snapshot source and trains it with the configured embedding model. Credentials are used for that request and are not stored. Run the import again when catalog content changes.

## Website URL scraper

Enter an optional Website URL while creating a chatbot, or choose **Knowledge → Add source → Website** later. Relay reads the requested public HTTPS page and follows same-site links until it reaches the selected limit of 1, 5 or 10 pages. It extracts readable server-rendered HTML, removes navigation and scripts, saves one source, and trains it with the configured embedding model.

The scraper rejects private-network addresses, custom ports, non-HTTPS URLs, cross-host redirects, non-HTML responses and pages over 2 MB. It honors page-level `noindex` and `nofollow` metadata. It does not render client-side JavaScript or currently discover `robots.txt` and sitemap rules, so use a direct public content URL for JavaScript-heavy sites.

## Shopify

Enter the store's `your-store.myshopify.com` domain and an Admin API access token that includes the `read_products` scope. Shopify's supported token flow depends on the app type; apps outside Shopify Admin use the authorization-code flow, while integrations for stores in your own organization can use client credentials. Relay queries the GraphQL Admin API and imports up to 50 products. See [Shopify authentication](https://shopify.dev/docs/apps/build/authentication-authorization) and the [products query](https://shopify.dev/docs/api/admin-graphql/latest/queries/products).

For a multi-merchant production connector, add Shopify OAuth installation and encrypted refresh-token storage. The current screen is suitable for an owner-supplied token and a one-time import.

## WooCommerce

In WordPress Admin, open **WooCommerce → Settings → Advanced → REST API**, add a key, choose **Read** permission, and copy its Consumer Key and Consumer Secret before closing the page. Enter those values with the public HTTPS store URL. Relay imports up to 50 published products from `wp-json/wc/v3/products`. See [WooCommerce REST API authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication).

## WordPress

Enter the public HTTPS site URL. No credential is needed for published posts and pages because the connector uses WordPress's public REST API. Private or password-protected content is not imported. See the [WordPress REST API handbook](https://developer.wordpress.org/rest-api/).

Connector requests reject private-network hosts, custom ports, non-HTTPS URLs, oversized responses, and authenticated redirects to another hostname. Secrets are never returned to the browser after the import request.
