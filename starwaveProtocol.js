/**
 iZ³ | Izzzio blockchain - https://izzz.io
 @author:  iZ³ Team (info@izzz.io)
 */

/**
 * moment js required
 * @type {number}
 */
'use strict'
const MESSAGE_MUTEX_TIMEOUT = 1000;
const LATENCY_TIME = 10 * 1000; //time on obsolescence of message

//const moment = require('moment');

class starwaveProtocol {

    constructor(candy, messageType) {
        this.recieverAddress = candy.recieverAddress;
        this.candy = candy;
        this.candy.MessageType = messageType;
        this.getid = candy.getid;
        /**
         * Input message mutex
         * @type {{}}
         * @private
         */
        this._messageMutex = {};
    }

    /**
     * Create message of starwave type
     * @param data
     * @param reciver
     * @param sender
     * @param id
     * @param timestamp
     * @param TTL
     * @param relevancyTime
     * @param route
     * @param type
     * @param timestampOfStart
     * @returns {{data: *, reciver: *, sender: *, id: *, timestamp: number, TTL: number, index: *, mutex: string, relevancyTime: Array, route: Array, type: number, timestampOfStart: number}}
     */
    createMessage(data, reciver, sender, id, timestamp, TTL, relevancyTime, route, type, timestampOfStart) {
        return {
            data: data,
            reciver: reciver,
            sender: sender !== undefined ? sender : this.candy.recieverAddress,
            id: id,
            timestamp: timestamp !== undefined ? timestamp : moment().utc().valueOf(),
            TTL: typeof TTL !== 'undefined' ? TTL : 0,
            mutex: this.getid() + this.getid() + this.getid(),
            relevancyTime: relevancyTime !== undefined ? relevancyTime : LATENCY_TIME, //time of message's relevancy
            route: route !== undefined ? route : [],
            type: type !== undefined ? type : this.candy.MessageType.SW_BROADCAST,
            timestampOfStart: timestampOfStart !== undefined ? timestampOfStart : moment().utc().valueOf()
        };
    };

    /**
     * Register message handler
     * @param {string} message
     * @param {function} handler
     * @return {boolean}
     */
    registerMessageHandler(message, handler) {
        let that = this;
        if(typeof that.candy !== 'undefined') {
            this.candy.registerMessageHandler(message, function (messageBody) {
                if(messageBody.id === message || message.length === 0) {
                    if(typeof  messageBody.mutex !== 'undefined' && typeof that._messageMutex[messageBody.mutex] === 'undefined') {
                        handler(messageBody);
                        that.handleMessageMutex(messageBody);
                    }
                }
            });
            return true;
        }
        return false;
    };


    /**
     * send message to peer directly(using busAddress)
     * @param messageBusAddress
     * @param {object} message
     */
    sendMessageToPeer(messageBusAddress, message) {
        let that = this;
        if(typeof that.candy !== 'undefined') {

            if(messageBusAddress === this.getAddress()) { //message to yourself
                this.handleMessage(message, this.candy.messagesHandlers, null);
                return true;
            } else {
                let socket = this.getSocketByBusAddress(messageBusAddress);

                if(!socket) {  //no such connected socket
                    return false;
                } else {
                    //add this node address if the route isn't complete
                    if(!this.routeIsComplete(message)) {
                        message.route.push(this.candy.recieverAddress);
                    }
                    //send the message
                    this.write(socket, message);
                    this.handleMessageMutex(message);
                    return true; //message has been sended
                }
            }

        }
    };

    /**
     * send broadcasting messages to all peers excluding previous sender
     * @param {object} message
     */
    broadcastMessage(message) {
        let that = this;
        //if the route is empty then it is the first sending and we send it to all
        if(typeof that.candy !== 'undefined') {
            let prevSender; //previous sender og the message
            if(message.route.length > 0) { //if the route is empty then it's the first sending of the message and we send it to all connected peers without exclusions
                //saving previous sender (last element in route array)
                prevSender = that.getSocketByBusAddress(message.route[message.route.length - 1]);
            }
            //adding our address to route
            message.route.push(this.candy.recieverAddress);
            //set message type
            message.type = this.candy.MessageType.SW_BROADCAST;
            //send to all except previous sender(if it's not the first sending)
            this.broadcast(message, prevSender);
            this.handleMessageMutex(message);
        }
    };

    /**
     *  send message using starwave protocol
     * @param message //message object
     */
    sendMessage(message) {
        if(!this.sendMessageToPeer(message.reciver, message)) {   //can't send directly, no such connected peer, then send to all
            //clear route starting from our address
            this.broadcastMessage(message);
            return 2; //sended broadcast
        }
        return 1; //sended directly to peer
    };

    /**
     * disassemble incoming message and decide what we should do with it
     * @param message
     * @returns {*}
     */
    manageIncomingMessage(message) {

        //message from ourselves
        if(message.sender === this.getAddress()) {
            try { //trying to close connection
                message._socket.close();
            } catch (e) {
            }
            return 0;
        }

        //check if the message is't too old
        if((moment().utc().valueOf()) > (message.timestamp + message.relevancyTime + LATENCY_TIME)) {
            return 0; //do nothing
        }
        //is it an endpoint of the message
        if(this.endpointForMessage(message)) {
            //save the route
            if(message.route.length > 1) { //if the route consist of the only element we don't save the route becase of direct connection to peer
                message.route.push(this.candy.recieverAddress);//reverse the route to use it in future sendings
                this.candy.routes[message.sender] = message.route.reverse().filter((v, i, a) => a.indexOf(v) === i);
            }
            return 1;   //message delivered
        } else {        //if the message shoud be forwarded
            //there should be foreward processing
            return 0;
        }
        //сообщение актуально и не достигло получателя, значит
        //проверяем наличие закольцованности. если в маршруте уже есть этот адрес, а конечная точка еще не нашлась,то не пускаем дальше
        //см. описание выше
        /* if(!this.routeIsComplete(message) &&
             (message.route.indexOf(this.candy.recieverAddress) > -1)) {
             return 0;                           //т.е. массив маршрута еще в стадии построения, и к нам пришло сообщение повторно
         }*/
    };

    /**
     * retranslate incoming message
     * @param message
     * @returns {*} sended message
     */
    retranslateMessage(message) {
        //change some information in message
        let newMessage = message;
        if(this.routeIsComplete(newMessage)) {
            let ind = newMessage.route.indexOf(this.candy.recieverAddress); // find index of this node in route array
            if(!this.sendMessageToPeer(newMessage.route[ind + 1], newMessage)) {  //can't send directly, no such connected peer, then send to all
                //clear route starting from our address because the toute is wrong and we should rebuild it
                newMessage.route = newMessage.route.splice(ind);
                this.broadcastMessage(newMessage);
            }
        } else {//if the route isn't complete
            this.sendMessage(newMessage);
        }
        return newMessage;
    };

    /**
     * full message processing according to the Protocol
     * @param message
     * @param messagesHandlers
     * @param ws
     * @returns {*} //id of processed message
     */
    handleMessage(message, messagesHandlers, ws) {
        if(message.type === this.candy.MessageType.SW_BROADCAST) {
            if(this.manageIncomingMessage(message) === 1) {
                //message is on the endpoint and we wxecute handlers
                for (let a in messagesHandlers) {
                    if(messagesHandlers.hasOwnProperty(a)) {
                        message._socket = ws;
                        if(messagesHandlers[a].handle(message)) {
                            return message.id; //if the message is processed we return
                        }
                    }
                }
            }
        }
    }

    /**
     * process the message mutex
     * @param messageBody
     */
    handleMessageMutex(messageBody) {
        this._messageMutex[messageBody.mutex] = true;
        setTimeout(() => {
            if(typeof this._messageMutex[messageBody.mutex] !== 'undefined') {
                delete this._messageMutex[messageBody.mutex];
            }
        }, MESSAGE_MUTEX_TIMEOUT);
    };

    /**
     * check if our node is the reciver
     * @param message
     * @returns {boolean}
     */
    endpointForMessage(message) {
        return message.reciver === this.candy.recieverAddress;
    };

    /**
     * check if our route is complete
     * @param message
     * @returns {boolean}
     */
    routeIsComplete(message) {
        return (message.route[message.route.length - 1] === message.reciver);
    };

    /**
     * Returns address
     * @return {string}
     */
    getAddress() {
        return this.candy.recieverAddress;
    };

    /**
     * Write to socket
     * @param ws
     * @param message
     */
    write (ws, message) {
        try {
            ws.send(JSON.stringify(message))
        } catch (e) { //send error. it's possibly that socket is inactive
            console.log('Send error: ' + e );
        }
    }

    /**
     * get the list of connected peers(sockets)
     * @returns {Array}
     */
    getCurrentPeers(fullSockets) {
        return this.candy.sockets.map(function (s) {
            if(s && s.readyState === 1) {
                if(fullSockets) {
                    return s;
                } else {
                    return 'ws://' + s._socket.remoteAddress + ':' + /*s._socket.remotePort*/ config.p2pPort
                }
            }
        }).filter((v, i, a) => a.indexOf(v) === i);
    }

    /**
     * find socket using bus address
     * @param address
     * @return {*}
     */
    getSocketByBusAddress(address) {
        const sockets = this.getCurrentPeers(true);
        for (let i in sockets) {
            if(sockets.hasOwnProperty(i)) {
                if(sockets[i] && sockets[i].nodeMetaInfo) {
                    if(sockets[i].nodeMetaInfo.messageBusAddress === address) {
                        return sockets[i];
                    }
                }
            }
        }

        return false;
    }

        /**
         * Broadcast message
         * @param message
         * @param excludeIp
         */
    broadcast(message, excludeIp) {
        let i;
        for (i = 0; i <= this.candy.sockets.length; i++){
            let socket = this.candy.sockets[i];
            if(typeof excludeIp === 'undefined' || socket !== excludeIp) {
                this.write(socket, message)
            } else {

            }
        }
    };
}
