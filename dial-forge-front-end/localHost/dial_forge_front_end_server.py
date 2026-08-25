#!/usr/bin/env python3
import http.server
import socketserver
import os
import socket
from pathlib import Path

PORT = 8000
BIND_ADDRESS = '0.0.0.0'

class DialForgeHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # If requesting root path, serve landingPage.html
        if self.path == '/' or self.path == '':
            self.path = '/landingPage.html'
        
        # Call parent class method to handle the request
        super().do_GET()

def get_local_ip():
    """Get the local IP address of this machine"""
    try:
        # Connect to an external host (doesn't actually send data)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return socket.gethostbyname(socket.gethostname())

def main():
    # Navigate to parent directory (dial-forge-front-end/)
    script_dir = Path(__file__).parent.absolute()
    project_root = script_dir.parent
    
    # Change to project root so server serves from correct location
    os.chdir(project_root)
    
    # Create and run server
    with socketserver.TCPServer((BIND_ADDRESS, PORT), DialForgeHandler) as httpd:
        # Get local IP
        local_ip = get_local_ip()
        
        # Print startup information
        print("\n" + "="*50)
        print("DialForge local server running")
        print("="*50)
        print(f"Local:   http://localhost:{PORT}")
        print(f"Network: http://{local_ip}:{PORT}")
        print(f"Home:    landingPage.html")
        print("="*50)
        print("Press Ctrl+C to stop the server\n")

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\nServer stopped.")

if __name__ == '__main__':
    main()
