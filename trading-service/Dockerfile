FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/trading-service .

FROM alpine:3.20
RUN adduser -D -u 1000 app
WORKDIR /app
COPY --from=build /out/trading-service /app/trading-service
USER app
EXPOSE 8081
CMD ["/app/trading-service"]
