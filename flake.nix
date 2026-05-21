{
  description = "Wayve Dev Environment (Multi-platform)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        # ===============================
        # 🧪 DEV SHELL
        # ===============================
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.rustc
            pkgs.cargo
            pkgs.nodejs_20
            pkgs.pnpm
            pkgs.postgresql
            pkgs.openssl
            pkgs.pkg-config
            pkgs.git
            pkgs.curl
            pkgs.cargo-watch
            pkgs.docker-compose
          ];

          shellHook = ''
            export DATABASE_URL=postgres://postgres:postgres@localhost:5432/wayve

            echo " Wayve Dev Ready (${system})"
            rustc --version
            node --version
          '';
        };

        # ===============================
        #  ONE COMMAND RUN
        # ===============================
        apps.default = {
          type = "app";
          program = toString (pkgs.writeShellScript "wayve-dev" ''
            echo " Starting Wayve (${system})..."

            # Start infra
            cd infra
            docker-compose up -d

            echo "⏳ Waiting for DB..."
            sleep 3

            # Start backend
            cd ../backend
            cargo run &

            # Start frontend
            cd ../frontend
            pnpm install
            pnpm dev &

            echo "✅ Wayve running"
            echo "Frontend: http://localhost:5173"
            echo "Backend: http://localhost:8080"

            wait
          '');
        };
      });
}