FROM nginx:alpine

# Copie de la configuration Nginx optimisée
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copie des fichiers statiques de l'application
COPY . /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
