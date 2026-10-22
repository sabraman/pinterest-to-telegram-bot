FROM rust:alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig openssl-dev sqlite-dev
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM alpine:latest
RUN apk add --no-cache ca-certificates libgcc
WORKDIR /app
COPY --from=builder /app/target/release/pinterest-to-telegram-bot /usr/local/bin/bot
VOLUME ["/app/data"]
CMD ["bot"]
