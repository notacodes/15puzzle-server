const WebSocket = require('ws');
const http = require('http');

// HTTP-Server erstellen
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello, welcome to the WebSocket server!');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// WebSocket-Server erstellen
const wss = new WebSocket.Server({ server });

let lobbies = {};
let puzzles = {};

function generateLobbyCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

wss.on('connection', ws => {
    let currentLobby = null;
    console.log('Player connected.');

    ws.on('message', message => {
        const data = JSON.parse(message);

        switch (data.action) {
            case 'createLobby':
                const lobbyCode = generateLobbyCode();
                const size = data.size || 3;
                const playerName = data.playerName;

                lobbies[lobbyCode] = {
                    players: [{
                        socket: ws,
                        name: playerName
                    }],
                    gameStarted: false
                };

                puzzles[lobbyCode] = {
                    puzzle: [],
                    size: size,
                    tilesize: 100,
                    completed: false
                };

                ws.send(JSON.stringify({
                    action: 'lobbyCreated',
                    code: lobbyCode,
                    size: size,
                    players: lobbies[lobbyCode].players.map(p => ({ name: p.name }))
                }));

                currentLobby = lobbyCode;
                break;

            case 'joinLobby':
                if (lobbies[data.code] && lobbies[data.code].players.length < 2) {
                    const existingPlayers = lobbies[data.code].players;

                    // Check if player with this name already exists
                    if (existingPlayers.some(p => p.name === data.playerName)) {
                        ws.send(JSON.stringify({
                            action: 'error',
                            message: 'Ein Spieler mit diesem Namen existiert bereits in der Lobby.'
                        }));
                        return;
                    }

                    // Add new player
                    existingPlayers.push({
                        socket: ws,
                        name: data.playerName
                    });

                    currentLobby = data.code;

                    // Broadcast updated player list to all players in lobby
                    existingPlayers.forEach(player => {
                        player.socket.send(JSON.stringify({
                            action: 'updatePlayerList',
                            players: existingPlayers.map(p => ({ name: p.name }))
                        }));
                    });

                    ws.send(JSON.stringify({
                        action: 'lobbyJoined',
                        code: data.code,
                        size: puzzles[data.code].size,
                        players: existingPlayers.map(p => ({ name: p.name }))
                    }));
                } else {
                    ws.send(JSON.stringify({
                        action: 'lobbyFull',
                        message: 'Lobby ist voll oder existiert nicht.'
                    }));
                }
                break;

            case 'startGame':
                if (lobbies[currentLobby] && lobbies[currentLobby].players.length === 2 && !lobbies[currentLobby].gameStarted && !puzzles[currentLobby].completed) {
                    lobbies[currentLobby].gameStarted = true;

                    const puzzle = generatePuzzle(currentLobby);

                    lobbies[currentLobby].players.forEach(player => {
                        player.socket.send(JSON.stringify({ action: 'gameStarted', puzzle }));
                    });
                }
                break;

            case 'move':
                if (lobbies[currentLobby] && lobbies[currentLobby].gameStarted) {
                    puzzles[currentLobby].puzzle = data.puzzle;
                    syncPuzzleToPlayers(currentLobby);
                    checkIfSolved(currentLobby);
                }
                break;

            case 'puzzleSolved':
                console.log('Puzzle solved');
                puzzles[currentLobby].completed = true;
                lobbies[currentLobby].players.forEach(player => {
                    console.log('Player object:', player); // Add this line to log the player object
                    if (player.socket && typeof player.socket.send === 'function') {
                        player.socket.send(JSON.stringify({ action: 'gameOver' }));
                    } else {
                        console.error('Player socket is not defined or send is not a function');
                    }
                });
                break;
        }
    });

    ws.on('close', () => {
        console.log('Player disconnected.');
        if (currentLobby && lobbies[currentLobby]) {
            lobbies[currentLobby].players = lobbies[currentLobby].players.filter(player => player !== ws);

            if (lobbies[currentLobby].players.length === 0) {
                delete lobbies[currentLobby];
                delete puzzles[currentLobby];
            } else {
                syncPuzzleToPlayers(currentLobby);
            }
        }
    });
});

function generatePuzzle(currentLobby) {
    if (!puzzles[currentLobby]) {
        throw new Error(`Puzzle data for lobby ${currentLobby} not found.`);
    }

    let size = puzzles[currentLobby].size;
    let tilesize = puzzles[currentLobby].tilesize;
    createPuzzle(size, tilesize, currentLobby);

    do {
        randomizePuzzle(size, currentLobby);
    } while (!isPuzzleValid(size, currentLobby) || !validateEmptyPuzzle(currentLobby));

    return puzzles[currentLobby].puzzle;
}

function createPuzzle(size, tilesize, currentLobby) {
    for (let i = 1; i <= size * size; i++) {
        puzzles[currentLobby].puzzle.push({
            value: i === size * size ? null : i,
            position: i,
            x: (getCol(i, size) - 1) * tilesize,
            y: (getRow(i, size) - 1) * tilesize,
            disabled: i === size * size,
        });
    }
}

function randomizePuzzle(size, currentLobby) {
    const puzzle = puzzles[currentLobby].puzzle;

    let randomValues;
    let correctTileCount;

    do {
        randomValues = getRandomValues(size);

        // Assign random values to the puzzle
        let i = 0;
        for (let puzzleItem of puzzle) {
            puzzleItem.value = randomValues[i];
            puzzleItem.disabled = false;
            i++;
        }

        const emptyPuzzle = puzzle.find((item) => item.value === size * size);
        emptyPuzzle.disabled = true;

        correctTileCount = countCorrectTiles(currentLobby);
    } while (correctTileCount > 3);
}

function isPuzzleValid(size, currentLobby) {
    let inversions = 0;
    const values = puzzles[currentLobby].puzzle.map((item) => item.value);

    for (let i = 0; i < values.length; i++) {
        for (let j = i + 1; j < values.length; j++) {
            if (values[i] > values[j] && values[i] !== size * size) inversions++;
        }
    }

    return size % 2 === 1 ? inversions % 2 === 0 : inversions % 2 === 1;
}

function validateEmptyPuzzle(currentLobby) {
    return puzzles[currentLobby].puzzle.filter((item) => item.disabled).length === 1;
}

function syncPuzzleToPlayers(lobbyCode) {
    const puzzle = puzzles[lobbyCode].puzzle;
    lobbies[lobbyCode].players.forEach(player => {
        player.socket.send(JSON.stringify({ action: 'updatePuzzle', puzzle }));
    });
}

function getRandomValues(size) {
    const values = Array.from({ length: size * size }, (_, i) => i + 1);
    return values.sort(() => Math.random() - 0.5);
}

function getRow(pos, size) {
    return Math.ceil(pos / size);
}

function getCol(pos, size) {
    const col = pos % size;
    return col === 0 ? size : col;
}

function countCorrectTiles(currentLobby) {
    const puzzle = puzzles[currentLobby].puzzle;
    let correctTiles = 0;
    for (let i = 0; i < puzzle.length; i++) {
        if (puzzle[i].value !== null && puzzle[i].value === puzzle[i].position) {
            correctTiles++;
        }
    }
    return correctTiles;
}

// Port für Render oder lokalen Server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));