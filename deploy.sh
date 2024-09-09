#!/usr/bin/env bash

set -ex

declare -a APPLICATIONS=("blog-comment-service-worker" "blog-comment-telegram-notifier")

if [ -z "$1" ]; then
    echo "Please provide the environment as an argument"
    exit 1
fi

env=$1

for i in "${APPLICATIONS[@]}"
do
   pushd "$i"
     npx wrangler deploy -c "wrangler-${env}.toml"
   popd
done
