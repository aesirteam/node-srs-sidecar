FROM node:10-alpine

COPY ./app /app

WORKDIR /app

RUN npm install --production

EXPOSE 3000

CMD ["npm","start"]

