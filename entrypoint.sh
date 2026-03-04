#!/bin/sh

if [ -z "$GEMINI_API_KEY" ]; then
  echo "WARNING: GEMINI_API_KEY environment variable is not set."
  echo "The application may not function correctly."
fi

echo "Injecting GEMINI_API_KEY into index.html..."
# Use sed to replace the placeholder with the actual API key (or empty string)
# Using | as delimiter to avoid conflicts with / in the key
sed -i "s|__GEMINI_API_KEY__|$GEMINI_API_KEY|g" /usr/share/nginx/html/index.html

# Start Nginx
echo "Starting Nginx..."
exec nginx -g "daemon off;"
