FROM node:10-jessie

RUN curl -LO https://storage.googleapis.com/kubernetes-release/release/$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)/bin/linux/amd64/kubectl && \
    chmod +x ./kubectl && \
    mv ./kubectl /usr/local/bin/kubectl

# install static binary for docker client
RUN curl -LO https://download.docker.com/linux/static/stable/x86_64/docker-18.03.1-ce.tgz && \
    tar xf docker-18.03.1-ce.tgz docker/docker && chmod +x docker/docker && \
    mv docker/docker /usr/local/bin/ && \
    rm -r docker

WORKDIR /app

ADD package.json package-lock.json /app/

RUN npm ci

ADD . /app

CMD node server/main.js
